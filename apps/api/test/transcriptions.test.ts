import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { createGroqTranscriber, MAX_AUDIO_BYTES, type Transcribe } from "../src/transcriptions.js";

const wav = Buffer.alloc(44);
wav.write("RIFF", 0); wav.write("WAVE", 8);
function form(bytes: BlobPart = new Uint8Array(wav), name = "recording.wav", mime = "audio/wav", field = "file") {
  const body = new FormData();
  body.append(field, new Blob([bytes], { type: mime }), name);
  return body;
}
async function withServer(transcribe: Transcribe, run: (url: string) => Promise<void>) {
  const app = createApp({ sale: { create: async () => { throw new Error("Database must not be used"); } } }, transcribe);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}/transcriptions`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("transcribes a multipart upload without database access", async () => {
  await withServer(async file => {
    assert.equal(file.size, 44);
    assert.deepEqual(file.buffer, wav);
    return "Two gowns at eight thousand naira.";
  }, async url => {
    const response = await fetch(url, { method: "POST", body: form() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transcript: "Two gowns at eight thousand naira." });
  });
});

test("browser MP4 audio is accepted as M4A only with the matching container header", async () => {
  let calls = 0;
  await withServer(async file => { calls++; assert.equal(file.mimetype, "audio/mp4"); return "transcript"; }, async url => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
    assert.equal((await fetch(url, { method: "POST", body: form(mp4, "recording.m4a", "audio/mp4") })).status, 200);
    assert.equal((await fetch(url, { method: "POST", body: form("not audio", "recording.m4a", "audio/mp4") })).status, 415);
    assert.equal(calls, 1);
  });
});

test("accepts curl's generic MP3 MIME with ID3 or MPEG signatures, but not renamed non-audio", async () => {
  let calls = 0;
  await withServer(async file => {
    calls++;
    assert.equal(file.mimetype, "audio/mpeg");
    return "MP3 transcript";
  }, async url => {
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    const mpeg = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    for (const mime of ["application/octet-stream", "audio/mpeg", "audio/mp3"]) {
      for (const bytes of [id3, mpeg]) {
        const response = await fetch(url, { method: "POST", body: form(bytes, "recording.mp3", mime) });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { transcript: "MP3 transcript" });
      }
    }
    for (const bytes of [new TextEncoder().encode("not an MP3"), new Uint8Array(wav)]) {
      const response = await fetch(url, { method: "POST", body: form(bytes, "renamed.mp3", "application/octet-stream") });
      assert.equal(response.status, 415);
      assert.deepEqual(await response.json(), { error: "File contents do not match the audio type." });
    }
    assert.equal(calls, 6);
  });
});

test("rejects missing, empty, malformed, unsupported, oversized and multiple uploads", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return "unexpected"; }, async url => {
    const multiple = form();
    multiple.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "other.wav");
    const extraField = form(); extraField.append("prompt", "not accepted");
    const cases: [BodyInit, number, Record<string, string>?][] = [
      [new FormData(), 400], [form(new Uint8Array()), 400],
      [form("not audio", "x.txt", "text/plain"), 415],
      [form("not audio"), 415], [form(new Uint8Array(wav), "x.wav", "text/plain"), 415],
      [form(new Uint8Array(MAX_AUDIO_BYTES + 1)), 413],
      [form(new Uint8Array(wav), "x.wav", "audio/wav", "audio"), 400],
      [multiple, 400], [extraField, 400],
      ["{}", 400, { "Content-Type": "application/json" }],
      ["invalid", 400, { "Content-Type": "multipart/form-data" }],
    ];
    for (const [body, status, headers] of cases) {
      const response = await fetch(url, { method: "POST", body, headers });
      assert.equal(response.status, status);
      assert.equal(typeof (await response.json()).error, "string");
    }
    assert.equal(calls, 0);
  });
});

test("official Groq request uses server credentials, supported model and multipart audio", async () => {
  const transcribe = createGroqTranscriber({ apiKey: () => "test-only-key", fetch: async (url, init) => {
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.deepEqual(init?.headers, { Authorization: "Bearer test-only-key" });
    assert.ok(init?.signal);
    const body = init?.body as FormData;
    assert.equal(body.get("model"), "whisper-large-v3-turbo");
    assert.equal(body.get("response_format"), "json");
    const file = body.get("file") as File;
    assert.equal(file.name, "audio.wav");
    assert.equal(file.size, 44);
    return Response.json({ text: "A transcript" });
  } });
  await withServer(transcribe, async url => {
    const response = await fetch(url, { method: "POST", body: form() });
    assert.deepEqual(await response.json(), { transcript: "A transcript" });
  });
});

test("configuration, provider errors, invalid responses and timeouts have safe responses", async () => {
  const scenarios: [Transcribe, number][] = [
    [createGroqTranscriber({ apiKey: () => undefined, fetch: async () => { throw new Error("must not call"); } }), 503],
    ...[400, 422, 401, 429, 500].map(status => [createGroqTranscriber({ apiKey: () => "test", fetch: async () => new Response("secret provider details", { status }) }), status === 400 || status === 422 ? 422 : status === 429 ? 503 : 502] as [Transcribe, number]),
    [createGroqTranscriber({ apiKey: () => "test", fetch: async () => Response.json({ unexpected: "secret" }) }), 502],
    [createGroqTranscriber({ apiKey: () => "test", fetch: async () => { throw new DOMException("secret", "TimeoutError"); } }), 504],
    [createGroqTranscriber({ apiKey: () => "test", fetch: async () => { throw new Error("secret network details"); } }), 502],
    [async () => { throw new Error("secret unexpected details"); }, 502],
  ];
  for (const [transcribe, status] of scenarios) await withServer(transcribe, async url => {
    const response = await fetch(url, { method: "POST", body: form() });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(!text.includes("secret"));
    assert.ok(!text.includes("test-only-key"));
  });
});

test("server diagnostics distinguish provider, network and response errors without sensitive data", async () => {
  const scenarios = [
    { fetch: async () => new Response("private-provider-body", { status: 401 }), category: "authentication", status: 502, upstream: 401 },
    { fetch: async () => new Response("private-provider-body", { status: 500 }), category: "upstream_http", status: 502, upstream: 500 },
    { fetch: async () => { throw new TypeError("private-error-message", { cause: { code: "UND_ERR_CONNECT_TIMEOUT", address: "private-address" } }); }, category: "timeout", status: 504, network: "UND_ERR_CONNECT_TIMEOUT" },
    { fetch: async () => { throw new TypeError("private-error-message", { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }); }, category: "network", status: 502, network: "SELF_SIGNED_CERT_IN_CHAIN" },
    { fetch: async () => { throw new TypeError("private-error-message", { cause: { code: "private-untrusted-code" } }); }, category: "network", status: 502 },
    { fetch: async () => new Response("private-invalid-json", { status: 200 }), category: "invalid_response", status: 502 },
  ];
  for (const scenario of scenarios) {
    const diagnostics: unknown[] = [];
    const transcribe = createGroqTranscriber({ apiKey: () => "private-api-key", fetch: scenario.fetch, log: entry => diagnostics.push(entry) });
    await withServer(transcribe, async url => {
      const response = await fetch(url, { method: "POST", body: form(new Uint8Array(wav), "private-filename.wav") });
      assert.equal(response.status, scenario.status);
      assert.equal(diagnostics.length, 1);
      const diagnostic = diagnostics[0] as Record<string, unknown>;
      assert.equal(diagnostic.category, scenario.category);
      assert.equal(diagnostic.upstreamStatus, scenario.upstream);
      assert.equal(diagnostic.networkCode, scenario.network);
      assert.equal(typeof diagnostic.diagnosticId, "string");
      assert.equal(typeof diagnostic.elapsedMs, "number");
      assert.ok(!JSON.stringify(diagnostics).includes("private-"));
      assert.ok(!(await response.text()).includes("private-"));
    });
  }
});
