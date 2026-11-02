import test from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError } from "../src/lib/api/client.ts";
import { clearDemoSession, demoToken, getDemoSession, setDemoSession } from "../src/lib/api/demo-session.ts";

test("authenticated API calls retain idempotency and multipart boundaries; 401 clears only the matching session", async () => {
  setDemoSession({ token: "memory-only-token", expiresAt: Date.now() + 60_000 });
  try {
    const api = createApi("https://api.example", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer memory-only-token");
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      assert.ok(init.body instanceof FormData);
      return Response.json({ transcript: "a test sale" });
    });
    assert.equal(await api.transcribe(new Blob(["audio"], { type: "audio/webm" })), "a test sale");
    const expired = createApi("https://api.example", async () => Response.json({ error: "Unlock again." }, { status: 401 }));
    await assert.rejects(expired.sales(), error => error instanceof ApiError && error.status === 401);
    assert.equal(getDemoSession(), null);
    setDemoSession({ token: "new-token", expiresAt: Date.now() + 60_000 });
    clearDemoSession("old-token"); assert.equal(demoToken(), "new-token");
  } finally { clearDemoSession(); }
});

test("sessions expire automatically and cannot be stored with expired timestamps", async () => {
  assert.throws(() => setDemoSession({ token: "expired", expiresAt: Date.now() - 1 }));
  setDemoSession({ token: "short-lived", expiresAt: Date.now() + 30 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(demoToken(), undefined); assert.equal(getDemoSession(), null);
});
