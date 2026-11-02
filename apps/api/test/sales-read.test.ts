import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Prisma } from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";
import { createSale, IdempotencyConflict, type StoredSale, type SaleWriter } from "../src/sales.js";
import { businessDay, salesSummary, type SaleReader } from "../src/sales-read.js";

test("business day uses Lagos midnight even when UTC is still the previous date", async () => {
  const day = businessDay(new Date("2026-10-20T23:30:00Z"));
  assert.equal(day.date, "2026-10-21");
  assert.equal(day.start.toISOString(), "2026-10-20T23:00:00.000Z");
  assert.equal(day.end.toISOString(), "2026-10-21T23:00:00.000Z");
  const result = await salesSummary({ sale: { aggregate: async args => {
    assert.equal(args.where.soldAt.gte.toISOString(), day.start.toISOString());
    return { _sum: { totalAmount: new Prisma.Decimal("70500.10") }, _count: { _all: 2 } };
  } } }, new Date("2026-10-20T23:30:00Z"));
  assert.equal(result.totalAmount, "70500.10"); assert.equal(result.saleCount, 2);
});

test("idempotent concurrent/retried saves reuse the primary key and reject changed payloads", async () => {
  const saved = new Map<string, StoredSale>(); let created = 0;
  const db: SaleWriter = { sale: {
    create: async ({ data }) => {
      if (!data.id) throw new Error("Test needs key");
      if (saved.has(data.id)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      const now = new Date();
      const sale: StoredSale = { id: data.id, totalAmount: data.totalAmount, recordingId: null, soldAt: now, createdAt: now, updatedAt: now, items: data.items.create.map((item, index) => ({ ...item, id: String(index), saleId: data.id ?? "", piecesPerUnit: item.piecesPerUnit ?? null, productId: item.productId ?? null, createdAt: now })) };
      saved.set(data.id, sale); created++; return sale;
    },
    findUnique: async ({ where }) => saved.get(where.id) ?? null,
  } };
  const payload = { items: [{ name: "gowns", quantity: 2, unit: "dozen", unitPrice: "24000.00" }] };
  const key = "56febd50-3e52-4a78-a949-e721b8394154";
  const [one, two] = await Promise.all([createSale(db, payload, key), createSale(db, payload, key)]);
  assert.deepEqual(one, two); assert.equal(created, 1);
  await assert.rejects(createSale(db, { items: [{ ...payload.items[0], quantity: 3 }] }, key), IdempotencyConflict);
  await assert.rejects(createSale(db, payload, "bad-key"));
});

test("read endpoints paginate, summarize, fail safely and narrowly allow frontend CORS", async () => {
  const now = new Date();
  const entries: StoredSale[] = [1, 2].map(i => ({ id: `sale-${i}`, soldAt: now, createdAt: now, updatedAt: now, totalAmount: new Prisma.Decimal("10.20"), recordingId: null, items: [] }));
  const db: SaleWriter & SaleReader = { sale: {
    create: async () => { throw new Error("Reads must not write"); },
    findMany: async args => { assert.equal(args.take, 2); if (args.cursor) assert.equal(args.skip, 1); return entries; },
    aggregate: async () => ({ _sum: { totalAmount: null }, _count: { _all: 0 } }),
  } };
  const server = createApp(db).listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/sales?limit=1`, { headers: { Origin: "http://localhost:3010" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3010");
    const page = await response.json(); assert.equal(page.sales.length, 1); assert.equal(page.nextCursor, "sale-1"); assert.equal(page.sales[0].totalAmount, "10.2");
    const summary = await (await fetch(`${base}/sales/summary`)).json(); assert.equal(summary.totalAmount, "0.00"); assert.equal(summary.saleCount, 0); assert.equal(summary.timeZone, "Africa/Lagos");
    assert.equal((await fetch(`${base}/sales?limit=500`)).status, 400);
    assert.equal((await fetch(`${base}/sales?cursor=bad`)).status, 400);
    const denied = await fetch(`${base}/sales?limit=1`, { headers: { Origin: "https://untrusted.example" } }); assert.equal(denied.headers.get("access-control-allow-origin"), null);
    db.sale.findMany = async () => { throw new Error("secret database details"); };
    const failed = await fetch(`${base}/sales?limit=1`); assert.equal(failed.status, 500); assert.ok(!(await failed.text()).includes("secret"));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
