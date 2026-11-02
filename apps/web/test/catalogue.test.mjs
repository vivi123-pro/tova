import test from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError } from "../src/lib/api/client.ts";
import { parseMatches, parseProductsPage, parseSale } from "../src/lib/api/contracts.ts";
import { createSalesFlow } from "../src/features/sales/sales-flow.ts";
import { validateReview } from "../src/features/sales/review.ts";

const sneakers = { id: "c90f13ce-b8b8-417b-a05a-0754a529e180", canonicalName: "Sneakers" };
const boots = { id: "eadf2d25-5747-4734-ad49-b375bd18d2b7", canonicalName: "Boots" };
const matched = product => ({ matched: true, matchType: "alias", product });
const unknown = { matched: false, matchType: null, product: null };
const draft = names => ({ currency: "NGN", requiresReview: true, items: names.map(name => ({ name, quantity: 2, unit: "pair", unitPrice: "4000.00", lineTotal: "8000.00" })), totalAmount: String(names.length * 8000), issues: [] });
const services = (overrides = {}) => ({ transcribe: async () => "retained transcript", extract: async () => draft(["Nike sneakers"]), save: async payload => ({ id: "saved", ...payload }), resolveProducts: async names => names.map(() => matched(sneakers)), createProduct: async () => boots, confirmAlias: async () => {}, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("extraction resolves canonical/confirmed names and saves IDs without replacing recorded names", async () => {
  let saved;
  const flow = createSalesFlow(services({
    extract: async () => draft(["Sneakers", "Nike sneakers"]),
    resolveProducts: async names => { assert.deepEqual(names, ["Sneakers", "Nike sneakers"]); return [{ ...matched(sneakers), matchType: "canonical" }, matched(sneakers)]; },
    save: async payload => { saved = payload; return { id: "saved", ...payload }; },
  }));
  await flow.process(new Blob());
  assert.deepEqual(flow.getSnapshot().rows.map(r => r.catalogue.product), [sneakers, sneakers]);
  await flow.save();
  assert.deepEqual(saved.items.map(i => [i.name, i.productId]), [["Sneakers", sneakers.id], ["Nike sneakers", sneakers.id]]);
  assert.equal(saved.items[0].unit, "pair");
});

test("unfamiliar names require creation or explicit alias confirmation, with no fuzzy matches", async () => {
  let creates = 0, aliases = 0, saves = 0;
  const flow = createSalesFlow(services({
    extract: async () => draft(["Adidas sneakers", "Boots"]), resolveProducts: async names => names.map(() => unknown),
    createProduct: async name => { creates++; assert.equal(name, "Boots"); return boots; },
    confirmAlias: async (id, name) => { aliases++; assert.equal(id, sneakers.id); assert.equal(name, "Adidas sneakers"); },
    save: async payload => { saves++; return payload; },
  }));
  await flow.process(new Blob());
  const [adidas, boot] = flow.getSnapshot().rows;
  assert.equal(creates, 0); assert.equal(aliases, 0);
  assert.equal(validateReview(flow.getSnapshot().rows).totalAmount, "16000.00");
  await flow.save(); assert.equal(saves, 0);
  await flow.confirmRowAlias(adidas.id, sneakers, false); assert.equal(aliases, 0);
  await flow.confirmRowAlias(adidas.id, sneakers, true);
  await flow.createRowProduct(boot.id);
  const checked = validateReview(flow.getSnapshot().rows);
  assert.deepEqual(checked.payload.items.map(item => [item.name, item.productId]), [["Adidas sneakers", sneakers.id], ["Boots", boots.id]]);
  assert.equal(aliases, 1); assert.equal(creates, 1); assert.equal(checked.valid, true);
});

test("lookup failures retain the draft and retry matching without retranscription or extraction", async () => {
  let transcriptions = 0, extractions = 0, resolutions = 0;
  const flow = createSalesFlow(services({
    transcribe: async () => { transcriptions++; return "original transcript"; },
    extract: async () => { extractions++; return draft(["Nike sneakers"]); },
    resolveProducts: async () => { if (++resolutions === 1) throw new ApiError("Catalogue unavailable", 503); return [matched(sneakers)]; },
  }));
  await flow.process(new Blob());
  assert.equal(flow.getSnapshot().phase, "review");
  assert.equal(flow.getSnapshot().rows[0].catalogue.status, "error");
  assert.equal(validateReview(flow.getSnapshot().rows).valid, false);
  await flow.resolveRows();
  assert.equal(flow.getSnapshot().rows[0].catalogue.product.id, sneakers.id);
  assert.equal(transcriptions, 1); assert.equal(extractions, 1); assert.equal(resolutions, 2);
});

test("creating a differently named canonical product requires confirmation and retains the recorded name", async () => {
  let creates = 0, aliases = 0;
  const flow = createSalesFlow(services({ resolveProducts: async () => [unknown], createProduct: async name => { creates++; assert.equal(name, "Sneakers"); return sneakers; }, confirmAlias: async (id, name) => { aliases++; assert.equal(id, sneakers.id); assert.equal(name, "Nike sneakers"); } }));
  await flow.process(new Blob()); const row = flow.getSnapshot().rows[0];
  await flow.createRowProduct(row.id, "Sneakers", false);
  assert.equal(creates, 0); assert.equal(aliases, 0);
  await flow.createRowProduct(row.id, "Sneakers", true);
  assert.equal(creates, 1); assert.equal(aliases, 1);
  assert.equal(flow.getSnapshot().rows[0].name, "Nike sneakers");
  assert.equal(validateReview(flow.getSnapshot().rows).payload.items[0].productId, sneakers.id);
});

test("edited names clear selections; delayed lookups cannot attach a stale product or overwrite edits", async () => {
  const waiting = deferred(); let count = 0;
  const flow = createSalesFlow(services({ resolveProducts: async () => ++count === 1 ? [matched(sneakers)] : waiting.promise }));
  await flow.process(new Blob());
  const row = flow.getSnapshot().rows[0];
  flow.updateRows([{ ...row, name: "Boots" }]);
  assert.equal(flow.getSnapshot().rows[0].catalogue.product, null);
  const lookup = flow.resolveRows(row.id);
  flow.updateRows([{ ...flow.getSnapshot().rows[0], name: "Sandals", quantity: "3" }]);
  waiting.resolve([matched(boots)]); await lookup;
  assert.equal(flow.getSnapshot().rows[0].name, "Sandals");
  assert.equal(flow.getSnapshot().rows[0].quantity, "3");
  assert.equal(flow.getSnapshot().rows[0].catalogue.status, "unchecked");
  assert.equal(validateReview(flow.getSnapshot().rows).payload, null);
});

test("pending catalogue writes ignore double clicks and stale completions after row removal", async () => {
  const waiting = deferred(); let creates = 0;
  const flow = createSalesFlow(services({ resolveProducts: async () => [unknown], createProduct: async () => { creates++; return waiting.promise; } }));
  await flow.process(new Blob());
  const row = flow.getSnapshot().rows[0];
  const first = flow.createRowProduct(row.id); await flow.createRowProduct(row.id);
  await flow.save(); assert.equal(flow.getSnapshot().attempt, null);
  flow.updateRows([]);
  waiting.resolve(boots); await first;
  assert.equal(creates, 1); assert.equal(flow.getSnapshot().rows.length, 0);
});

test("alias conflicts stay unresolved until exact lookup confirms the existing owner", async () => {
  let count = 0;
  const flow = createSalesFlow(services({ resolveProducts: async () => ++count === 1 ? [unknown] : [matched(boots)], confirmAlias: async () => { throw new ApiError("That name is already registered to another product.", 409); } }));
  await flow.process(new Blob());
  const row = flow.getSnapshot().rows[0];
  await flow.confirmRowAlias(row.id, sneakers, true);
  assert.equal(flow.getSnapshot().rows[0].catalogue.status, "error");
  assert.equal(flow.getSnapshot().rows[0].catalogue.product, null);
  await flow.resolveRows(row.id);
  assert.equal(flow.getSnapshot().rows[0].catalogue.product.id, boots.id);
});

test("creation retries recover a lost response via a duplicate conflict and exact resolution", async () => {
  let createRequests = 0, records = 0;
  const api = createApi("http://test", async (url, init) => {
    if (url.endsWith("/products")) {
      assert.deepEqual(JSON.parse(init.body), { canonicalName: "Boots" });
      if (++createRequests === 1) { records++; throw new Error("Lost successful response"); }
      return Response.json({ error: "That name is already registered in the catalogue." }, { status: 409 });
    }
    assert.equal(url, "http://test/products/resolve");
    assert.deepEqual(JSON.parse(init.body), { names: ["Boots"] });
    return Response.json({ matches: [{ ...matched(boots), matchType: "canonical" }] });
  });
  await assert.rejects(api.createProduct("Boots"), ApiError);
  assert.deepEqual(await api.createProduct("Boots"), boots);
  assert.equal(records, 1); assert.equal(createRequests, 2);
});

test("catalogue client validates contracts, paginates and sends confirmed aliases explicitly", async () => {
  const api = createApi("http://test", async (url, init) => {
    if (url.includes("/products?")) { assert.equal(url, `http://test/products?limit=50&cursor=${boots.id}`); return Response.json({ products: [sneakers], nextCursor: null }); }
    assert.equal(url, `http://test/products/${sneakers.id}/aliases`);
    assert.deepEqual(JSON.parse(init.body), { name: "Nike sneakers", confirmed: true });
    return Response.json({ registration: { id: crypto.randomUUID(), name: "Nike sneakers", productId: sneakers.id, kind: "alias" }, created: false });
  });
  assert.deepEqual((await api.products(boots.id)).products, [sneakers]);
  await api.confirmAlias(sneakers.id, "Nike sneakers");
  for (const value of [{ matches: [] }, { matches: [{ matched: true, product: null, matchType: "alias" }] }, { matches: [{ matched: false, product: sneakers, matchType: null }] }]) assert.throws(() => parseMatches(value, 1));
  assert.throws(() => parseProductsPage({ products: [{ id: "bad", canonicalName: "Bad" }], nextCursor: null }));
});

test("a lost alias response can be retried explicitly without registering another alias", async () => {
  let attempts = 0, registrations = 0;
  const api = createApi("http://test", async (url, init) => {
    if (url.endsWith("/resolve")) return Response.json({ matches: [unknown] });
    assert.deepEqual(JSON.parse(init.body), { name: "Nike sneakers", confirmed: true });
    if (++attempts === 1) { registrations++; throw new Error("Lost response after registration"); }
    return Response.json({ registration: { productId: sneakers.id, kind: "alias" }, created: false });
  });
  const flow = createSalesFlow(services({ resolveProducts: api.resolveProducts, confirmAlias: api.confirmAlias }));
  await flow.process(new Blob());
  const row = flow.getSnapshot().rows[0];
  await flow.confirmRowAlias(row.id, sneakers, true);
  assert.equal(flow.getSnapshot().rows[0].catalogue.status, "error");
  await flow.confirmRowAlias(row.id, sneakers, true);
  assert.equal(flow.getSnapshot().rows[0].catalogue.product.id, sneakers.id);
  assert.equal(attempts, 2); assert.equal(registrations, 1);
});

test("refresh rechecks editable matches but preserves a fixed sale retry payload and product IDs", async () => {
  let stored = null, saves = 0, firstPayload, firstKey, lookups = 0;
  const persistence = { read: () => stored, write: value => { stored = value; } };
  const configured = services({ resolveProducts: async () => { lookups++; return [matched(sneakers)]; }, save: async (payload, key) => {
    if (++saves === 1) { firstPayload = payload; firstKey = key; throw new ApiError("Response lost", 0); }
    assert.deepEqual(payload, firstPayload); assert.equal(key, firstKey); return { id: key, ...payload };
  } });
  const flow = createSalesFlow(configured, persistence); await flow.process(new Blob());
  const refreshed = createSalesFlow(configured, persistence); refreshed.restore();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 2); assert.equal(refreshed.getSnapshot().rows[0].catalogue.product.id, sneakers.id);
  await refreshed.save();
  const pending = createSalesFlow(configured, persistence); pending.restore();
  assert.equal(lookups, 2); assert.equal(pending.getSnapshot().phase, "save-error");
  await pending.save();
  assert.equal(saves, 2); assert.equal(pending.getSnapshot().phase, "saved"); assert.equal(stored, null);
  assert.equal(firstPayload.items[0].productId, sneakers.id);
});

test("historical sales accept absent/null product IDs and legacy pending saves retain their old payload", async () => {
  const original = { id: "old-sale", soldAt: "2026-10-21T12:00:00Z", totalAmount: "8000", items: [{ id: "old-item", name: "gowns", quantity: 2, unit: "dozen", unitPrice: "4000", lineTotal: "8000" }] };
  assert.deepEqual(parseSale(original), original);
  assert.equal(parseSale({ ...original, items: [{ ...original.items[0], productId: null }] }).items[0].productId, null);
  const rows = [{ id: "old-row", name: "gowns", quantity: "2", unit: "dozen", unitPrice: "4000" }];
  const payload = validateReview(rows).payload;
  const stored = JSON.stringify({ transcript: "old transcript", draft: draft(["gowns"]), rows, attempt: { key: crypto.randomUUID(), payload } });
  let resolutions = 0;
  const flow = createSalesFlow(services({ resolveProducts: async () => { resolutions++; return []; }, save: async data => { assert.deepEqual(data, payload); return original; } }), { read: () => stored, write: () => {} });
  flow.restore(); await flow.save();
  assert.equal(flow.getSnapshot().phase, "saved"); assert.equal(resolutions, 0);
});
