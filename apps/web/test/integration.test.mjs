import test from "node:test";
import assert from "node:assert/strict";
import { createApi, audioUpload, ApiError } from "../src/lib/api/client.ts";
import { parseDraft, parseSalesPage, parseSummary } from "../src/lib/api/contracts.ts";
import { validateReview, draftRows, cents } from "../src/features/sales/review.ts";
import { createSalesFlow } from "../src/features/sales/sales-flow.ts";

const draft = { currency: "NGN", requiresReview: true, items: [{ name: "gowns", quantity: 2, unit: "dozen", unitPrice: "24000.00", lineTotal: "48000.00" }, { name: "jeans", quantity: 3, unit: "piece", unitPrice: "7500.00", lineTotal: "22500.00" }], totalAmount: "70500.00", issues: [] };
const sale = { id: "ffe16c3f-d4fd-4bd5-80ca-e9833e2f5b34", soldAt: "2026-10-21T12:00:00Z", totalAmount: "70500", items: draft.items.map((item, i) => ({ ...item, id: `item-${i}` })) };

test("audio uploads use file field, real container extension, normalized MIME and no manual multipart header", async () => {
  for (const [mime, expected] of [["audio/webm;codecs=opus", "webm"], ["audio/mp4;codecs=mp4a.40.2", "m4a"], ["audio/ogg;codecs=opus", "ogg"]]) {
    const api = createApi("http://localhost:4000/", async (url, init) => {
      assert.equal(url, "http://localhost:4000/transcriptions");
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      const file = init.body.get("file");
      assert.equal(file.name, `recording.${expected}`);
      assert.equal(file.type, mime.split(";")[0]);
      return Response.json({ transcript: "two dozen gowns" });
    });
    assert.equal(await api.transcribe(new Blob(["audio"], { type: mime })), "two dozen gowns");
  }
  assert.throws(() => audioUpload(new Blob(["x"], { type: "text/plain" })));
  assert.throws(() => audioUpload(new Blob([], { type: "audio/webm" })));
});

test("extraction contract preserves nulls and review issues; invalid responses fail closed", () => {
  const uncertain = { ...draft, items: [{ name: "gowns", quantity: null, unit: null, unitPrice: null, lineTotal: null }], totalAmount: null, issues: [{ itemIndex: 0, field: "quantity", code: "missing_or_uncertain" }] };
  assert.deepEqual(parseDraft(uncertain), uncertain);
  assert.equal(draftRows(uncertain)[0].quantity, "");
  assert.equal(draftRows(uncertain)[0].unitPrice, "");
  for (const value of [{}, { ...draft, requiresReview: undefined }, { ...draft, items: [{ ...draft.items[0], quantity: "2" }] }]) assert.throws(() => parseDraft(value));
  assert.throws(() => parseSalesPage({ sales: [{}], nextCursor: null }));
  assert.throws(() => parseSummary({ date: "today", timeZone: "UTC", saleCount: 0, totalAmount: "0" }));
});

test("review validation preserves wholesale units and uses exact money arithmetic", () => {
  const rows = draftRows(draft);
  const checked = validateReview(rows);
  assert.equal(checked.totalAmount, "70500.00");
  assert.deepEqual(checked.payload, { items: draft.items.map(({ name, quantity, unit, unitPrice }) => ({ name, quantity, unit, unitPrice })) });
  const fractional = validateReview([{ ...rows[0], quantity: "3", unitPrice: "0.10" }, { ...rows[1], quantity: "2", unitPrice: "1.25" }]);
  assert.equal(fractional.totalAmount, "2.80");
  assert.equal(checked.payload.items[0].quantity, 2);
  assert.equal(checked.payload.items[0].unit, "dozen");
  assert.equal("lineTotal" in checked.payload.items[0], false);
  assert.equal("totalAmount" in checked.payload, false);
  for (const change of [{ name: " " }, { quantity: "" }, { quantity: "1.5" }, { quantity: "0" }, { quantity: "2147483648" }, { unit: "" }, { unitPrice: "" }, { unitPrice: "0" }, { unitPrice: "1e3" }, { unitPrice: "1.001" }, { unitPrice: "999999999999.99" }]) assert.equal(validateReview([{ ...rows[0], ...change }]).valid, false);
  assert.equal(validateReview([]).valid, false);
  assert.equal(cents("0.10"), 10n);
});

test("API extraction/save requests send only actual contract fields and retain idempotency key", async () => {
  const checked = validateReview(draftRows(draft));
  const key = crypto.randomUUID();
  const api = createApi("http://localhost:4000", async (url, init) => {
    if (url.endsWith("/sales/extract")) {
      assert.deepEqual(JSON.parse(init.body), { transcript: "two dozen gowns" });
      return Response.json(draft);
    }
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), key);
    assert.deepEqual(JSON.parse(init.body), checked.payload);
    return Response.json(sale, { status: 201 });
  });
  assert.deepEqual(await api.extract("two dozen gowns"), draft);
  assert.deepEqual(await api.save(checked.payload, key), sale);
});

test("processing retry retains successful transcript and does not call transcription twice", async () => {
  let transcribed = 0, extracted = 0;
  const flow = createSalesFlow({ transcribe: async () => { transcribed++; return "my transcript"; }, extract: async () => { if (++extracted === 1) throw new Error("Extraction unavailable"); return draft; }, save: async () => sale });
  await flow.process(new Blob(["audio"]));
  assert.equal(flow.getSnapshot().phase, "error");
  assert.equal(flow.getSnapshot().transcript, "my transcript");
  await flow.process(new Blob(["audio"]));
  assert.equal(transcribed, 1); assert.equal(extracted, 2);
  assert.equal(flow.getSnapshot().phase, "review");
  assert.deepEqual(flow.getSnapshot().draft, draft);
});

test("lost save responses, repeated clicks and session restoration reuse one exact save attempt", async () => {
  let serialized = null, count = 0, firstKey, firstPayload;
  const persistence = { read: () => serialized, write: value => { serialized = value; } };
  const services = { transcribe: async () => "transcript", extract: async () => draft, save: async (payload, key) => {
    count++;
    if (count === 1) { firstKey = key; firstPayload = payload; throw new ApiError("Response lost", 0); }
    assert.equal(key, firstKey); assert.deepEqual(payload, firstPayload); return sale;
  } };
  const flow = createSalesFlow(services, persistence);
  await flow.process(new Blob(["private audio"]));
  await Promise.all([flow.save(), flow.save()]);
  assert.equal(count, 1); assert.equal(flow.getSnapshot().phase, "save-error");
  const before = flow.getSnapshot().rows;
  flow.updateRows([]); assert.deepEqual(flow.getSnapshot().rows, before);
  assert.equal(flow.reset(), false);
  assert.ok(!serialized.includes("private audio"));
  const restored = createSalesFlow(services, persistence); restored.restore();
  assert.equal(restored.getSnapshot().phase, "save-error");
  await restored.save();
  assert.equal(count, 2); assert.equal(restored.getSnapshot().phase, "saved"); assert.equal(serialized, null);
});

test("network errors and unsafe or unsuccessful API responses do not create a usable result", async () => {
  for (const request of [async () => { throw new Error("private details"); }, async () => new Response("<html>private</html>", { status: 500 }), async () => Response.json({ transcript: " " })]) {
    const api = createApi("http://localhost:4000", request);
    await assert.rejects(api.transcribe(new Blob(["audio"], { type: "audio/webm" })), error => !error.message.includes("private"));
  }
});

test("a retained transcript can resume extraction after refresh without audio", async () => {
  const stored = JSON.stringify({ transcript: "retained transcript", draft: null, rows: [], attempt: null });
  const flow = createSalesFlow({ transcribe: async () => { throw new Error("Must not retranscribe"); }, extract: async transcript => { assert.equal(transcript, "retained transcript"); return draft; }, save: async () => sale }, { read: () => stored, write: () => {} });
  flow.restore();
  await flow.process(new Blob());
  assert.equal(flow.getSnapshot().phase, "review");
});

test("definitive validation rejection preserves editable fields rather than locking a rejected save", async () => {
  const flow = createSalesFlow({ transcribe: async () => "transcript", extract: async () => draft, save: async () => { throw new ApiError("Please correct your input", 400); } });
  await flow.process(new Blob(["audio"])); await flow.save();
  assert.equal(flow.getSnapshot().phase, "review"); assert.equal(flow.getSnapshot().attempt, null);
  const rows = flow.getSnapshot().rows.map(row => ({ ...row, unit: "pack" }));
  flow.updateRows(rows); assert.equal(flow.getSnapshot().rows[0].unit, "pack");
});
