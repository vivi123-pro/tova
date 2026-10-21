import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { buildDraft, createGroqExtractor, type Extract } from "../src/extraction.js";
import { createApp } from "../src/app.js";
import { createApi } from "../../web/src/lib/api/client.ts";
import { createSalesFlow } from "../../web/src/features/sales/sales-flow.ts";
import { validateReview } from "../../web/src/features/sales/review.ts";

const wholesale = "2 dozens of gowns at ₦24,000 per dozen";
const gown = { name: "gowns", quantity: 2, unit: "dozen", unitPrice: "24000.00", evidence: { name: "gowns", quantity: "2", unit: "dozen", unitPrice: "₦24,000" }, uncertainFields: [] };
const model = (items: unknown[] = [gown], uncertain = false) => ({ items, uncertain });

test("preserves wholesale selling units and computes exact server totals", () => {
  const result = buildDraft(model(), wholesale);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].unit, "dozen");
  assert.equal(result.items[0].unitPrice, "24000.00");
  assert.equal(result.items[0].lineTotal, "48000.00");
  assert.equal(result.totalAmount, "48000.00");
  assert.equal(result.requiresReview, true);
});

test("multiple items and spoken numbers use exact decimal arithmetic", () => {
  const transcript = "two pieces of gowns at 0.10 per piece and three pairs of trousers at five thousand naira per pair";
  const result = buildDraft(model([
    { ...gown, unit: "piece", unitPrice: "0.10", evidence: { name: "gowns", quantity: "two", unit: "pieces", unitPrice: "0.10" } },
    { name: "trousers", quantity: 3, unit: "pair", unitPrice: "5000", evidence: { name: "trousers", quantity: "three", unit: "pairs", unitPrice: "five thousand naira" }, uncertainFields: [] },
  ]), transcript);
  assert.equal(result.items[0].lineTotal, "0.20");
  assert.equal(result.items[1].lineTotal, "15000.00");
  assert.equal(result.totalAmount, "15000.20");
});

test("each and apiece establish pieces alongside wholesale units", () => {
  for (const expression of ["each", "apiece"]) {
    const transcript = `I sold two dozens of gowns at 24,000 Naira per dozen and three jeans at 7,500 Naira ${expression}.`;
    const result = buildDraft(model([
      { ...gown, evidence: { name: "gowns", quantity: "two", unit: "dozen", unitPrice: "24,000 Naira" } },
      { name: "jeans", quantity: 3, unit: "piece", unitPrice: "7500.00", evidence: { name: "jeans", quantity: "three", unit: expression, unitPrice: "7,500 Naira" }, uncertainFields: [] },
    ]), transcript);
    assert.deepEqual(result.items.map(({ quantity, unit, unitPrice, lineTotal }) => ({ quantity, unit, unitPrice, lineTotal })), [
      { quantity: 2, unit: "dozen", unitPrice: "24000.00", lineTotal: "48000.00" },
      { quantity: 3, unit: "piece", unitPrice: "7500.00", lineTotal: "22500.00" },
    ]);
    assert.equal(result.totalAmount, "70500.00");
    assert.deepEqual(result.issues, []);
  }
});

test("per-item expressions never erase missing units, package units or genuine uncertainty", () => {
  const jeans = { name: "jeans", quantity: 3, unit: "piece", unitPrice: "7500", evidence: { name: "jeans", quantity: "three", unit: "each", unitPrice: "7500" }, uncertainFields: [] };
  const missing = buildDraft(model([{ ...jeans, unit: null, evidence: { ...jeans.evidence, unit: null } }], true), "three jeans at 7500");
  assert.equal(missing.items[0].unit, null);
  assert.equal(missing.totalAmount, null);
  assert.ok(missing.issues.some(issue => issue.code === "ambiguous_transcript"));
  const uncertain = buildDraft(model([{ ...jeans, uncertainFields: ["unit"] }], true), "three jeans at 7500 each, maybe per pack");
  assert.equal(uncertain.items[0].unit, null);
  assert.equal(uncertain.totalAmount, null);
  const borrowed = buildDraft(model([jeans]), "three jeans at 7500 and two shirts at 5000 each");
  assert.equal(borrowed.items[0].unit, null);
  for (const expression of ["each", "apiece"]) {
    const transcript = `2 dozens of gowns at 24000 ${expression}`;
    const explicit = { ...gown, evidence: { ...gown.evidence, unit: "dozens", unitPrice: "24000" } };
    assert.equal(buildDraft(model([explicit]), transcript).totalAmount, "48000.00");
    const converted = buildDraft(model([{ ...explicit, unit: "piece", evidence: { ...explicit.evidence, unit: expression } }]), transcript);
    assert.equal(converted.items[0].unit, null);
    assert.equal(converted.totalAmount, null);
  }
});

test("each/apiece prices an explicit wholesale unit, including plural bags, boxes and bales", () => {
  for (const [plural, singular] of [["bags", "bag"], ["sacks", "sack"], ["boxes", "box"], ["bales", "bale"], ["crates", "crate"], ["dozens", "dozen"], ["packs", "pack"], ["bundles", "bundle"], ["cartons", "carton"]]) {
    for (const expression of ["each", "apiece"]) {
      const transcript = `Three ${plural} of goods at four thousand naira ${expression}.`;
      const item = { name: "goods", quantity: 3, unit: singular, unitPrice: "4000.00", evidence: { name: "goods", quantity: "Three", unit: plural, unitPrice: "four thousand naira" }, uncertainFields: [] };
      for (const evidence of [plural, expression]) {
        const result = buildDraft(model([{ ...item, evidence: { ...item.evidence, unit: evidence } }]), transcript);
        assert.equal(result.items[0].unit, singular);
        assert.equal(result.items[0].lineTotal, "12000.00");
        assert.equal(result.totalAmount, "12000.00");
        assert.deepEqual(result.issues, []);
      }
      const incorrectPiece = buildDraft(model([{ ...item, unit: "piece", evidence: { ...item.evidence, unit: expression } }]), transcript);
      assert.equal(incorrectPiece.items[0].unit, null);
      assert.equal(incorrectPiece.totalAmount, null);
    }
  }
});

test("missing prices, conflicting units and borrowed each evidence remain unresolved", () => {
  const item = { name: "rice", quantity: 3, unit: "bag", unitPrice: null, evidence: { name: "rice", quantity: "Three", unit: "bags", unitPrice: null }, uncertainFields: ["unitPrice"] };
  const missing = buildDraft(model([item], true), "Three bags of rice, price not stated.");
  assert.equal(missing.items[0].unit, "bag");
  assert.equal(missing.items[0].unitPrice, null);
  assert.equal(missing.items[0].lineTotal, null);
  assert.equal(missing.totalAmount, null);
  assert.ok(missing.issues.some(issue => issue.field === "unitPrice"));
  const invented = buildDraft(model([{ ...item, unitPrice: "4000", evidence: { ...item.evidence, unitPrice: "four thousand naira" }, uncertainFields: [] }]), "Three bags of rice each.");
  assert.equal(invented.items[0].unitPrice, null);
  const candidate = { ...item, unitPrice: "4000", evidence: { ...item.evidence, unit: "each", unitPrice: "four thousand naira" }, uncertainFields: [] };
  const borrowed = buildDraft(model([candidate]), "Three bags of rice at four thousand naira and two shirts at 5000 each.");
  assert.equal(borrowed.items[0].unit, null);
  const conflicting = buildDraft(model([candidate], true), "Three bags or boxes of rice at four thousand naira each.");
  assert.equal(conflicting.items[0].unit, null);
  assert.ok(conflicting.issues.some(issue => issue.code === "ambiguous_transcript"));
});

test("case-only evidence differences preserve facts but substituted or invented numbers do not", () => {
  const transcript = "Three bags of rice at four thousand naira each.";
  const item = { name: "rice", quantity: 3, unit: "bag", unitPrice: "4000.00", evidence: { name: "RICE", quantity: "three", unit: "BAGS", unitPrice: "four thousand Naira" }, uncertainFields: [] };
  const result = buildDraft(model([item]), transcript);
  assert.equal(result.items[0].quantity, 3);
  assert.equal(result.totalAmount, "12000.00");
  assert.deepEqual(result.issues, []);
  const unsupported = buildDraft(model([{ ...item, evidence: { ...item.evidence, quantity: "3" } }]), transcript);
  assert.equal(unsupported.items[0].quantity, null);
  const wrongValue = buildDraft(model([{ ...item, quantity: 30 }]), transcript);
  assert.equal(wrongValue.items[0].quantity, null);
});

test("rice transcript travels through Groq JSON, API normalization and editable review without writes", async () => {
  const transcript = "Three bags of rice at four thousand naira each.";
  const raw = model([{ name: "rice", quantity: 3, unit: "bag", unitPrice: "4000.00", evidence: { name: "rice", quantity: "three", unit: "bags", unitPrice: "four thousand naira" }, uncertainFields: [] }]);
  let writes = 0;
  const extract = createGroqExtractor({ apiKey: () => "test-key", fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.messages[1].content, transcript);
    assert.match(request.messages[0].content, /including clothing, food and other wholesale goods/);
    assert.match(request.messages[0].content, /ANY explicitly stated selling unit/);
    assert.doesNotMatch(request.messages[0].content, /Only extract explicitly stated clothing/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(raw) } }] });
  } });
  const server = createApp({ sale: { create: async () => { writes++; throw new Error("No sales may be created"); } } }, undefined, extract).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const api = createApi(`http://127.0.0.1:${address.port}`);
    const flow = createSalesFlow({ transcribe: async () => transcript, extract: api.extract, save: async () => { throw new Error("Save must not run"); } });
    await flow.process(new Blob());
    const state = flow.getSnapshot();
    assert.equal(state.phase, "review");
    assert.equal(state.transcript, transcript);
    assert.deepEqual(state.draft?.items[0], { name: "rice", quantity: 3, unit: "bag", unitPrice: "4000.00", lineTotal: "12000.00" });
    assert.deepEqual(state.draft?.issues, []);
    const { id: _id, ...fields } = state.rows[0];
    assert.deepEqual(fields, { name: "rice", quantity: "3", unit: "bag", unitPrice: "4000.00" });
    assert.equal(validateReview(state.rows).totalAmount, "12000.00");
    assert.equal(writes, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("ambiguous or missing fields stay null; no partial grand total", () => {
  const result = buildDraft(model([{ ...gown, unitPrice: null, evidence: { ...gown.evidence, unitPrice: null }, uncertainFields: ["quantity"] }], true), "maybe 2 dozens of gowns");
  assert.equal(result.items[0].quantity, null);
  assert.equal(result.items[0].unitPrice, null);
  assert.equal(result.items[0].lineTotal, null);
  assert.equal(result.totalAmount, null);
  assert.ok(result.issues.some(i => i.code === "ambiguous_transcript"));
  assert.equal(buildDraft(model([], true), "nothing sold").totalAmount, null);
});

test("unsupported model claims are nulled and flagged rather than invented", () => {
  const result = buildDraft(model([{ ...gown, quantity: 24, name: "shirts", evidence: { ...gown.evidence, name: "shirts" } }]), wholesale);
  assert.equal(result.items[0].quantity, null);
  assert.equal(result.items[0].name, null);
  assert.equal(result.totalAmount, null);
  assert.equal(result.issues.length, 2);
});

test("rejects invalid model fields, extra totals and overflow", () => {
  for (const value of [null, {}, model([{ ...gown, totalAmount: "1" }]), model([{ ...gown, quantity: -2 }]), model([{ ...gown, unitPrice: "1.001" }]), model([{ ...gown, unitPrice: 24000 }]), model([{ ...gown, evidence: {} }])]) {
    assert.throws(() => buildDraft(value, wholesale));
  }
  const overflow = buildDraft(model([{ ...gown, unitPrice: "999999999999.99", evidence: { ...gown.evidence, unitPrice: "999999999999.99" } }]), "2 dozens gowns 999999999999.99");
  assert.equal(overflow.totalAmount, null);
  assert.ok(overflow.issues.some(i => i.code === "amount_out_of_range"));
});

async function withEndpoint(extract: Extract, run: (post: (input: unknown) => Promise<Response>) => Promise<void>) {
  const app = createApp({ sale: { create: async () => { throw new Error("Database writes forbidden"); } } }, undefined, extract);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    await run(input => fetch(`http://127.0.0.1:${address.port}/sales/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("POST returns a draft without database writes and validates transcript requests", async () => {
  let calls = 0;
  await withEndpoint(async transcript => { calls++; assert.equal(transcript, wholesale); return model(); }, async post => {
    const response = await post({ transcript: wholesale });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).totalAmount, "48000.00");
    for (const input of [null, {}, { transcript: " " }, { transcript: 42 }, { transcript: "x".repeat(8001) }, { transcript: wholesale, totalAmount: "1" }]) assert.equal((await post(input)).status, 400);
    assert.equal(calls, 1);
  });
});

test("Groq request uses strict structured output, configured server key and separate transcript data", async () => {
  const extract = createGroqExtractor({ apiKey: () => "test-secret", fetch: async (url, init) => {
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-secret");
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages[1].content, wholesale);
    assert.match(body.messages[0].content, /Never invent/);
    assert.match(body.messages[0].content, /"each" and "apiece" establish unit piece/);
    assert.match(body.messages[0].content, /Explicit selling units take precedence/);
    assert.match(body.messages[0].content, /Evidence must preserve spoken number words exactly/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(model()) } }] });
  } });
  await withEndpoint(extract, async post => assert.equal((await post({ transcript: wholesale })).status, 200));
});

test("provider failures, malformed/truncated JSON, missing config and timeouts are safe", async () => {
  const scenarios: { fetch?: typeof fetch; key?: string; status: number; category: string }[] = [
    { status: 503, category: "configuration" },
    ...[401, 429, 500].map(status => ({ key: "test-secret", fetch: async () => new Response("private-provider-body", { status }), status: status === 429 ? 503 : 502, category: status === 401 ? "authentication" : "upstream_http" })),
    { key: "test-secret", fetch: async () => { throw new Error("private-network-error"); }, status: 502, category: "network" },
    { key: "test-secret", fetch: async () => { throw new DOMException("private-timeout", "TimeoutError"); }, status: 504, category: "timeout" },
    ...["{", JSON.stringify({ ...model(), totalAmount: "1" }), JSON.stringify(model([{ ...gown, quantity: "two" }]))].map(content => ({ key: "test-secret", fetch: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }), status: 502, category: "invalid_response" })),
    { key: "test-secret", fetch: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(model()) } }] }), status: 502, category: "invalid_response" },
  ];
  for (const scenario of scenarios) {
    const logs: Record<string, unknown>[] = [];
    const extract = createGroqExtractor({ apiKey: () => scenario.key, fetch: scenario.fetch, log: entry => logs.push(entry) });
    await withEndpoint(extract, async post => {
      const response = await post({ transcript: wholesale });
      assert.equal(response.status, scenario.status);
      assert.equal(logs[0].category, scenario.category);
      assert.ok(!JSON.stringify(logs).includes("private"));
      assert.ok(!JSON.stringify(logs).includes("test-secret"));
      assert.ok(!JSON.stringify(logs).includes(wholesale));
      assert.ok(!(await response.text()).includes("private"));
    });
  }
});
