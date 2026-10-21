import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { prepareSale, ValidationError, type SaleWriter } from "../src/sales.js";

const item = { name: " Rice ", quantity: 3, unit: "bag", unitPrice: "0.10" };

test("calculates exact totals for multiple items; package size is descriptive", () => {
  const sale = prepareSale({ items: [item, { ...item, quantity: 2, unitPrice: "1.25", piecesPerUnit: 50 }] });
  assert.equal(sale.totalAmount.toFixed(2), "2.80");
  assert.deepEqual(sale.items.create.map(i => i.lineTotal.toFixed(2)), ["0.30", "2.50"]);
  assert.equal(sale.items.create[0].name, "Rice");
});

test("rejects malformed input, invalid values, caller totals and monetary overflow", () => {
  const invalid = [null, [], {}, { items: [] }, { items: Array(101).fill(item) },
    { items: [item], totalAmount: "1" }, { items: [item], soldAt: "2020-01-01" },
    ...[{ quantity: 0 }, { quantity: 1.5 }, { quantity: 2147483648 }, { unitPrice: "0" },
      { unitPrice: "-1" }, { unitPrice: "1.001" }, { unitPrice: 1 }, { unitPrice: "1e3" },
      { name: " " }, { unit: "" }, { piecesPerUnit: 0 }, { piecesPerUnit: null },
      { lineTotal: "1" }, { quantity: 2, unitPrice: "999999999999.99" }]
      .map(change => ({ items: [{ ...item, ...change }] })),
    { items: [1, 2].map(() => ({ ...item, quantity: 1, unitPrice: "999999999999.99" })) }];
  for (const input of invalid) assert.throws(() => prepareSale(input), ValidationError);
});

test("POST /sales creates all items in one nested write and returns decimal strings", async () => {
  let calls = 0;
  const db: SaleWriter = { sale: { create: async ({ data, include }) => {
    calls++;
    assert.equal(include.items, true);
    assert.equal(data.items.create.length, 2);
    assert.equal("recordingId" in data, false);
    assert.equal("soldAt" in data, false);
    return { id: "sale-id", totalAmount: data.totalAmount, items: data.items.create };
  } } };
  const server = createApp(db).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/sales`;
    const post = (body: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const response = await post(JSON.stringify({ items: [item, item] }));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.totalAmount, "0.6");
    assert.equal(body.items[0].unitPrice, "0.1");
    assert.equal(body.items[0].lineTotal, "0.3");
    assert.equal((await post('{"items":[]}')).status, 400);
    assert.equal((await post('{')).status, 400);
    assert.equal(calls, 1);
    db.sale.create = async () => { throw new Error("secret connection detail"); };
    const failure = await post(JSON.stringify({ items: [item] }));
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { error: "Unable to create sale." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
