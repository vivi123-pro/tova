import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { CatalogueError, createProduct, normalizeProductName, registerAlias, resolveProductNames, type CatalogueClient, type CatalogueTransaction } from "../src/catalogue.js";
import { createApp } from "../src/app.js";
import { createSale, IdempotencyConflict, prepareSale, ValidationError, type StoredSale, type SaleWriter } from "../src/sales.js";
import { Prisma, type Product, type ProductAlias } from "../src/generated/prisma/client.js";
import { createApi } from "../../web/src/lib/api/client.ts";
import { createSalesFlow } from "../../web/src/features/sales/sales-flow.ts";
import { validateReview } from "../../web/src/features/sales/review.ts";

// Emulate transactional rollback and the registry's unique constraint without
// touching Supabase. PostgreSQL itself is responsible for concurrency isolation.
function catalogueFixture() {
  let products = new Map<string, Product>();
  let names = new Map<string, ProductAlias>();
  let queue: Promise<unknown> = Promise.resolve();
  const transaction: CatalogueTransaction = {
    product: {
      create: async ({ data }) => { const row = { id: randomUUID(), ...data, createdAt: new Date() }; products.set(row.id, row); return row; },
      findUnique: async ({ where }) => products.get(where.id) ?? null,
      findMany: async args => {
        const sorted = [...products.values()].sort((a, b) => a.id.localeCompare(b.id));
        const start = args.cursor ? sorted.findIndex(p => p.id === args.cursor?.id) + (args.skip ?? 0) : 0;
        return sorted.slice(start, start + args.take).map(product => ({ ...product, names: [...names.values()].filter(name => name.productId === product.id && !name.isCanonical).sort((a, b) => a.normalizedName.localeCompare(b.normalizedName)) }));
      },
    },
    productAlias: {
      create: async ({ data }) => {
        if ([...names.values()].some(name => name.normalizedName === data.normalizedName)) throw Object.assign(new Error("Unique name"), { code: "P2002" });
        const row = { id: randomUUID(), ...data, createdAt: new Date() }; names.set(row.id, row); return row;
      },
      findUnique: async ({ where }) => { const name = [...names.values()].find(n => n.normalizedName === where.normalizedName); const product = name && products.get(name.productId); return name && product ? { ...name, product } : null; },
      findMany: async ({ where }) => [...names.values()].filter(n => where.normalizedName.in.includes(n.normalizedName)).flatMap(name => { const product = products.get(name.productId); return product ? [{ ...name, product }] : []; }),
    },
  };
  const db: CatalogueClient = { ...transaction, $transaction: work => {
    const pending = queue.then(async () => {
      const previousProducts = new Map(products), previousNames = new Map(names);
      try { return await work(transaction); }
      catch (error) { products = previousProducts; names = previousNames; throw error; }
    });
    queue = pending.catch(() => {}); return pending;
  } };
  return { db, get productCount() { return products.size; }, get nameCount() { return names.size; } };
}

test("normalization is case/spacing/Unicode aware without guessing name equivalence", () => {
  assert.deepEqual(normalizeProductName("  Nike\t SNEAKERS  "), { name: "Nike SNEAKERS", normalizedName: "nike sneakers" });
  assert.equal(normalizeProductName("Ｓｎｅａｋｅｒｓ").normalizedName, "sneakers");
  assert.notEqual(normalizeProductName("Nike sneakers").normalizedName, normalizeProductName("Adidas sneakers").normalizedName);
  assert.notEqual(normalizeProductName("sneaker").normalizedName, normalizeProductName("sneakers").normalizedName);
  assert.notEqual(normalizeProductName("T-shirt").normalizedName, normalizeProductName("T shirt").normalizedName);
  for (const value of [null, 1, " ", "x".repeat(201), "Sneak\u200bers", "bad\u0000name"]) assert.throws(() => normalizeProductName(value), CatalogueError);
});

test("canonical names and aliases share one unambiguous namespace with atomic rollback", async () => {
  const f = catalogueFixture();
  const sneakers = await createProduct(f.db, "Sneakers");
  await assert.rejects(createProduct(f.db, "  SNEAKERS  "), error => error instanceof CatalogueError && error.status === 409);
  assert.equal(f.productCount, 1); assert.equal(f.nameCount, 1);
  await registerAlias(f.db, sneakers.id, "Nike sneakers", true);
  await assert.rejects(createProduct(f.db, "NIKE SNEAKERS"), error => error instanceof CatalogueError && error.status === 409);
  assert.equal(f.productCount, 1);
  const shoes = await createProduct(f.db, "Shoes");
  await assert.rejects(registerAlias(f.db, shoes.id, "nike sneakers", true), error => error instanceof CatalogueError && error.status === 409);
  await assert.rejects(registerAlias(f.db, shoes.id, "SNEAKERS", true), error => error instanceof CatalogueError && error.status === 409);
  const retry = await registerAlias(f.db, sneakers.id, " Nike sneakers ", true);
  assert.equal(retry.created, false);
  assert.equal((await registerAlias(f.db, sneakers.id, "sneakers", true)).registration.kind, "canonical");
});

test("resolution only returns known names; aliases require explicit confirmation", async () => {
  const f = catalogueFixture(); const product = await createProduct(f.db, "Sneakers");
  const unknown = await resolveProductNames(f.db, ["Nike sneakers", "Adidas sneakers"]);
  assert.ok(unknown.every(name => !name.matched && name.product === null)); assert.equal(f.nameCount, 1);
  for (const confirmed of [undefined, false, "true", 1]) await assert.rejects(registerAlias(f.db, product.id, "Nike sneakers", confirmed), CatalogueError);
  await registerAlias(f.db, product.id, "Nike sneakers", true);
  await registerAlias(f.db, product.id, "Adidas sneakers", true);
  const matches = await resolveProductNames(f.db, [" SNEAKERS ", "nike SNEAKERS", "ADIDAS sneakers", "Sneaker", "Puma sneakers"]);
  assert.deepEqual(matches.map(m => m.matchType), ["canonical", "alias", "alias", null, null]);
  assert.ok(matches.slice(0, 3).every(m => m.product?.id === product.id));
  assert.equal(f.productCount, 1); assert.equal(f.nameCount, 3);
  await assert.rejects(registerAlias(f.db, randomUUID(), "Puma sneakers", true), error => error instanceof CatalogueError && error.status === 404);
});

test("competing name claims have one winner; failed creation leaves no orphan product", async () => {
  const f = catalogueFixture();
  const results = await Promise.allSettled([createProduct(f.db, "Sneakers"), createProduct(f.db, "SNEAKERS")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.productCount, 1); assert.equal(f.nameCount, 1);
});

test("sale product linking is explicit, preserves recorded names and participates in idempotency", async () => {
  const f = catalogueFixture(); const product = await createProduct(f.db, "Sneakers");
  await registerAlias(f.db, product.id, "Nike sneakers", true);
  const saved = new Map<string, StoredSale>(); let lookups = 0;
  const db: SaleWriter = { product: { findUnique: async args => { lookups++; return f.db.product.findUnique(args); } }, sale: {
    create: async ({ data }) => {
      const id = data.id ?? randomUUID(); if (saved.has(id)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
      const now = new Date(); const sale: StoredSale = { id, recordingId: null, totalAmount: data.totalAmount, soldAt: now, createdAt: now, updatedAt: now, items: data.items.create.map(item => ({ ...item, id: randomUUID(), saleId: id, productId: item.productId ?? null, piecesPerUnit: item.piecesPerUnit ?? null, createdAt: now })) }; saved.set(id, sale); return sale;
    }, findUnique: async ({ where }) => saved.get(where.id) ?? null,
  } };
  const item = { name: "Nike sneakers", quantity: 2, unit: "pair", unitPrice: "10000.00" };
  const legacyKey = randomUUID(); await createSale(db, { items: [item] }, legacyKey);
  assert.equal(lookups, 0); assert.equal(saved.get(legacyKey)?.items[0].productId, null);
  const original = saved.get(legacyKey);
  await registerAlias(f.db, product.id, "New confirmed name", true);
  assert.deepEqual(saved.get(legacyKey), original); // Catalogue writes do not touch historical items.
  await createSale(db, { items: [item] }, legacyKey);
  const linkedKey = randomUUID();
  await createSale(db, { items: [{ ...item, productId: product.id }] }, linkedKey);
  assert.equal(saved.get(linkedKey)?.items[0].productId, product.id);
  assert.equal(saved.get(linkedKey)?.items[0].name, "Nike sneakers");
  await assert.rejects(createSale(db, { items: [{ ...item, productId: randomUUID() }] }), ValidationError);
  await assert.rejects(createSale(db, { items: [item] }, linkedKey), IdempotencyConflict);
  assert.throws(() => prepareSale({ items: [{ ...item, productId: "bad" }] }), ValidationError);
  assert.equal(prepareSale({ items: [{ ...item, productId: null }] }).items.create[0].productId, null);
});

test("catalogue HTTP operations are bounded, validated and compatible with existing sales", async () => {
  const f = catalogueFixture(); let savedBody: unknown;
  const app = createApp({ ...f.db, sale: { create: async ({ data }) => { savedBody = data; return { id: "legacy-sale", items: data.items.create, totalAmount: data.totalAmount }; } } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, value: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const created = await post("/products", { canonicalName: "Sneakers" }); assert.equal(created.status, 201); const product = await created.json();
    assert.equal((await post(`/products/${product.id}/aliases`, { name: "Nike sneakers", confirmed: false })).status, 400);
    assert.equal((await post(`/products/${product.id}/aliases`, { name: "Nike sneakers", confirmed: true })).status, 201);
    assert.equal((await post(`/products/${product.id}/aliases`, { name: "NIKE SNEAKERS", confirmed: true })).status, 200);
    assert.equal((await post("/products", { canonicalName: "NIKE SNEAKERS" })).status, 409);
    const second = await (await post("/products", { canonicalName: "Boots" })).json();
    assert.equal((await post(`/products/${second.id}/aliases`, { name: "Nike sneakers", confirmed: true })).status, 409);
    const resolved = await (await post("/products/resolve", { names: [" nike sneakers ", "Adidas sneakers"] })).json();
    assert.equal(resolved.matches[0].product.id, product.id); assert.equal(resolved.matches[1].product, null);
    const listed = await fetch(`${base}/products?limit=1`); assert.equal(listed.status, 200); const page = await listed.json();
    assert.equal(page.products.length, 1); assert.ok(page.nextCursor);
    const next = await (await fetch(`${base}/products?limit=1&cursor=${page.nextCursor}`)).json();
    assert.equal(next.products.length, 1); assert.equal(next.nextCursor, null);
    assert.notEqual(next.products[0].id, page.products[0].id);
    const sneakers = [...page.products, ...next.products].find(p => p.id === product.id);
    assert.equal(sneakers.aliases.length, 1); assert.equal(sneakers.aliases[0].name, "Nike sneakers");
    assert.equal((await fetch(`${base}/products?limit=500`)).status, 400);
    assert.equal((await fetch(`${base}/products?cursor=bad`)).status, 400);
    assert.equal((await post("/products", { canonicalName: "Boots", brand: "No brands" })).status, 400);
    assert.equal((await post("/products/resolve", { names: [] })).status, 400);
    const item = { name: "Nike sneakers", quantity: 2, unit: "pair", unitPrice: "10000.00" };
    assert.equal((await post("/sales", { items: [item] })).status, 201);
    assert.equal((savedBody as { items: { create: { productId?: string }[] } }).items.create[0].productId, undefined);
    assert.equal((await post("/sales", { items: [{ ...item, productId: product.id }] })).status, 201);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("unexpected catalogue errors return and log no raw database details", async () => {
  const f = catalogueFixture(); const diagnostics: string[] = [];
  f.db.product.findMany = async () => { throw Object.assign(new Error("private database details"), { code: "P1001" }); };
  const server = createApp({ ...f.db, sale: { create: async () => { throw new Error("No sale writes expected"); } } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const originalError = console.error;
  console.error = (...values) => diagnostics.push(values.join(" "));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/products`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Unable to complete the catalogue request." });
    assert.deepEqual(diagnostics.map(value => JSON.parse(value)), [{ event: "catalogue_request_failed", code: "P1001" }]);
  } finally {
    console.error = originalError;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("migration is additive, bounded and leaves historical sales unlinked", async () => {
  const sql = await readFile(new URL("../prisma/migrations/20261022090000_product_catalogue/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /BEGIN;/); assert.match(sql, /COMMIT;/); assert.match(sql, /lock_timeout = '5s'/);
  assert.match(sql, /ALTER TABLE "SaleItem" ADD COLUMN\s+"productId" TEXT;/);
  assert.match(sql, /CREATE UNIQUE INDEX "ProductAlias_normalizedName_key" ON "ProductAlias"\("normalizedName"\)/);
  assert.match(sql, /"SaleItem_productId_fkey".*ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/gm);
});

test("real Express contracts integrate extraction, matching, alias confirmation, product creation and retry-safe saving", async () => {
  const f = catalogueFixture(); const sneakers = await createProduct(f.db, "Sneakers");
  await registerAlias(f.db, sneakers.id, "Nike sneakers", true);
  const sales = new Map<string, StoredSale>(); let writes = 0;
  const now = new Date();
  const historical: StoredSale = { id: randomUUID(), recordingId: null, totalAmount: new Prisma.Decimal("5000"), soldAt: now, createdAt: now, updatedAt: now, items: [] };
  historical.items = [{ id: randomUUID(), saleId: historical.id, name: "Old recorded item", productId: null, quantity: 1, unit: "piece", piecesPerUnit: null, unitPrice: historical.totalAmount, lineTotal: historical.totalAmount, createdAt: now }];
  sales.set(historical.id, historical);
  const historyBefore = JSON.stringify(historical);
  const db = { ...f.db, sale: {
    create: async ({ data }: Parameters<SaleWriter["sale"]["create"]>[0]) => {
      const id = data.id ?? randomUUID();
      if (sales.has(id)) throw Object.assign(new Error("Duplicate"), { code: "P2002" });
      const sale: StoredSale = { id, recordingId: null, totalAmount: data.totalAmount, soldAt: now, createdAt: now, updatedAt: now, items: data.items.create.map(item => ({ ...item, id: randomUUID(), saleId: id, productId: item.productId ?? null, piecesPerUnit: item.piecesPerUnit ?? null, createdAt: now })) };
      writes++; sales.set(id, sale); return sale;
    },
    findUnique: async ({ where }: { where: { id: string } }) => sales.get(where.id) ?? null,
    findMany: async () => [...sales.values()],
  } };
  const names = ["Nike sneakers", "Adidas sneakers", "Boots"];
  const transcript = names.map(name => `2 pairs of ${name} at 4000 per pair`).join(" and ");
  const model = { uncertain: false, items: names.map(name => ({ name, quantity: 2, unit: "pair", unitPrice: "4000", evidence: { name, quantity: "2", unit: "pairs", unitPrice: "4000" }, uncertainFields: [] })) };
  const server = createApp(db, undefined, async () => model).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    let lost = false;
    const api = createApi(`http://127.0.0.1:${address.port}`, async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/sales") && init?.method === "POST" && response.ok && !lost) { lost = true; await response.arrayBuffer(); throw new Error("Simulated lost success response"); }
      return response;
    });
    let persisted: string | null = null;
    const persistence = { read: () => persisted, write: (value: string | null) => { persisted = value; } };
    const services = { ...api, transcribe: async () => transcript };
    const flow = createSalesFlow(services, persistence);
    await flow.process(new Blob());
    const [nike, adidas, boot] = flow.getSnapshot().rows;
    assert.equal(nike.catalogue?.product?.id, sneakers.id);
    assert.equal(adidas.catalogue?.status, "unmatched"); assert.equal(boot.catalogue?.status, "unmatched");
    assert.equal(f.productCount, 1); assert.equal(f.nameCount, 2);
    await flow.save(); assert.equal(writes, 0);
    assert.equal((await api.products()).products[0].canonicalName, "Sneakers");
    await flow.confirmRowAlias(adidas.id, sneakers, false); assert.equal(f.nameCount, 2);
    await flow.confirmRowAlias(adidas.id, sneakers, true);
    await api.confirmAlias(sneakers.id, "ADIDAS SNEAKERS"); // A confirmed retry is harmless.
    assert.equal(f.nameCount, 3);
    await flow.createRowProduct(boot.id);
    const boots = flow.getSnapshot().rows[2].catalogue?.product; assert.ok(boots);
    // Canonical-name creation retries recover the same stable ID through 409 + resolution.
    assert.equal((await api.createProduct("BOOTS")).id, boots.id); assert.equal(f.productCount, 2);
    await assert.rejects(api.confirmAlias(boots.id, "Adidas sneakers"), error => !!error && typeof error === "object" && "status" in error && error.status === 409);
    const payload = validateReview(flow.getSnapshot().rows).payload; assert.ok(payload);
    assert.deepEqual(payload.items.map(item => [item.name, item.productId]), [["Nike sneakers", sneakers.id], ["Adidas sneakers", sneakers.id], ["Boots", boots.id]]);
    await Promise.all([flow.save(), flow.save()]);
    assert.equal(flow.getSnapshot().phase, "save-error"); assert.equal(writes, 1);
    const restored = createSalesFlow(services, persistence); restored.restore(); await restored.save();
    assert.equal(restored.getSnapshot().phase, "saved"); assert.equal(writes, 1); assert.equal(sales.size, 2);
    const saved = restored.getSnapshot().savedSale; assert.ok(saved);
    assert.equal(saved.totalAmount, "24000");
    assert.deepEqual(saved.items.map(item => [item.name, item.productId, item.quantity, item.unit, item.unitPrice, item.lineTotal]), names.map((name, index) => [name, index === 2 ? boots.id : sneakers.id, 2, "pair", "4000", "8000"]));
    const page = await api.sales();
    assert.equal(page.sales.find(sale => sale.id === historical.id)?.items[0].productId, null);
    assert.equal(JSON.stringify(sales.get(historical.id)), historyBefore);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
