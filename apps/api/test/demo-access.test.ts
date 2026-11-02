import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createDemoApp, allowedOrigins } from "../src/demo-app.js";
import { demoConfig, hashPassword, type DemoConfig } from "../src/demo-access.js";
import { databaseUrl } from "../src/database-config.js";

const password = "test-only-presenter-password";
const users = { presenter: await hashPassword(password), reviewer: await hashPassword("test-only-reviewer-password") };
const baseConfig: DemoConfig = { secret: "test-only-signing-secret-32-bytes-minimum", users, deadline: Date.now() + 3_600_000, ttlSeconds: 900, version: "1" };
async function fixture(run: (f: { base: string; login: (username?: string, pass?: string) => Promise<Response>; advance: (ms: number) => void; calls: () => number }) => Promise<void>, config = baseConfig, hold?: { wait: Promise<void>; started: () => void }) {
  let now = Date.now(), calls = 0;
  const db = { sale: { findMany: async () => { calls++; return []; }, aggregate: async () => ({ _sum: { totalAmount: null }, _count: { _all: 0 } }) } } as unknown as Parameters<typeof createDemoApp>[0];
  const app = createDemoApp(db, { config, origins: ["https://demo.example"], clock: () => now, extract: async () => { calls++; hold?.started(); await hold?.wait; return { items: [], uncertain: false }; }, transcribe: async () => { calls++; return "test transcript"; } });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
  const base = `http://127.0.0.1:${address.port}`;
  try { await run({ base, login: (username = "presenter", pass = password) => fetch(`${base}/demo/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: pass }) }), advance: ms => { now += ms; }, calls: () => calls }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("protected business endpoints reject requests before database, JSON or paid processing", async () => {
  await fixture(async ({ base, calls }) => {
    for (const [method, path] of [["GET", "/sales"], ["POST", "/sales"], ["GET", "/sales/summary"], ["GET", "/products"], ["POST", "/products"], ["POST", "/products/resolve"], ["POST", "/products/id/aliases"], ["POST", "/transcriptions"], ["POST", "/sales/extract"]]) {
      const response = await fetch(base + path, { method, ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "malformed" } : {}) });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    assert.equal(calls(), 0);
    assert.equal((await fetch(base + "/health")).status, 200);
  });
});

test("both credentials work; invalid credentials, forged tokens and expired tokens fail", async () => {
  await fixture(async ({ base, login, advance, calls }) => {
    assert.equal((await login("unknown")).status, 401);
    assert.equal((await login("presenter", "incorrect")).status, 401);
    assert.equal((await login("reviewer", "test-only-reviewer-password")).status, 200);
    const response = await login(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const { token } = await response.json();
    const request = (value: string) => fetch(base + "/sales", { headers: { Authorization: `Bearer ${value}` } });
    assert.equal((await request(token)).status, 200); assert.equal(calls(), 1);
    assert.equal((await request(token + "forged")).status, 401);
    advance(900_000);
    assert.equal((await request(token)).status, 401); assert.equal(calls(), 1);
  });
});

test("version rotation and hard demo deadline revoke access", async () => {
  await fixture(async ({ base, login, advance }) => {
    const { token } = await (await login()).json();
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    payload.v = "old-version";
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", baseConfig.secret).update(encoded).digest("base64url");
    assert.equal((await fetch(base + "/sales", { headers: { Authorization: `Bearer ${encoded}.${signature}` } })).status, 401);
    advance(3_600_001);
    assert.equal((await login()).status, 401);
    assert.equal((await fetch(base + "/sales", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  });
});

test("login throttles attempts; AI quota blocks paid functions; counters recover", async () => {
  await fixture(async ({ base, login, advance, calls }) => {
    const { token } = await (await login()).json();
    for (let i = 0; i < 10; i++) assert.equal((await fetch(base + "/sales/extract", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ transcript: "test" }) })).status, 200);
    assert.equal(calls(), 10);
    const limited = await fetch(base + "/sales/extract", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "600"); assert.equal(calls(), 10);
    for (let i = 0; i < 9; i++) await login("presenter", "wrong");
    assert.equal((await login()).status, 429);
    advance(600_001); assert.equal((await login()).status, 200);
  });
});

test("production CORS permits exact origin and authenticated preflight only", async () => {
  assert.throws(() => allowedOrigins({ NODE_ENV: "production" }));
  for (const invalid of ["*", "https://demo.example/path", "http://demo.example", "https://*.vercel.app"]) {
    assert.throws(() => allowedOrigins({ NODE_ENV: "production", CORS_ORIGINS: invalid }));
  }
  await fixture(async ({ base }) => {
    const response = await fetch(base + "/sales", { method: "OPTIONS", headers: { Origin: "https://demo.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization,Content-Type,Idempotency-Key" } });
    assert.equal(response.status, 204); assert.equal(response.headers.get("access-control-allow-origin"), "https://demo.example");
    assert.match(response.headers.get("access-control-allow-headers")!, /Authorization/);
    const denied = await fetch(base + "/sales", { headers: { Origin: "https://untrusted.example" } });
    assert.equal(denied.status, 401); assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });
});

test("missing configuration fails closed and production TLS uses a portable verified CA", () => {
  assert.throws(() => demoConfig({}));
  assert.throws(() => demoConfig({ DEMO_TOKEN_SECRET: baseConfig.secret, DEMO_USERS_JSON: JSON.stringify(users), DEMO_ACCESS_EXPIRES_AT: "yesterday" }));
  assert.throws(() => databaseUrl("not-a-url"));
  assert.throws(() => databaseUrl("postgresql://user:password@db.example/demo", { NODE_ENV: "production" }));
  const url = new URL(databaseUrl("postgresql://user:password@db.example/demo?sslmode=disable&sslrootcert=C%3A%2Fobsolete.crt", { NODE_ENV: "production", DATABASE_CA_PATH: "certs/prod-ca-2021.crt" }));
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.match(url.searchParams.get("sslrootcert")!, /certs\/prod-ca-2021.crt$/);
});

test("concurrent AI requests for one credential are blocked before processing and release afterward", async () => {
  let release!: () => void, notify!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notify = resolve; });
  try {
    await fixture(async ({ base, login, calls }) => {
      const { token } = await (await login()).json();
      const request = () => fetch(base + "/sales/extract", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ transcript: "test" }) });
      const first = request(); await started;
      assert.equal((await request()).status, 429); assert.equal(calls(), 1);
      release(); assert.equal((await first).status, 200);
      assert.equal((await request()).status, 200); assert.equal(calls(), 2);
    }, baseConfig, { wait, started: notify });
  } finally { release(); }
});

test("compressed JSON is rejected safely on public login and protected business routes", async () => {
  await fixture(async ({ base, login, calls }) => {
    const compressed = gzipSync(JSON.stringify({ username: "presenter", password }));
    const response = await fetch(base + "/demo/login", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: compressed });
    assert.equal(response.status, 415);
    const { token } = await (await login()).json();
    assert.equal((await fetch(base + "/sales", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", Authorization: `Bearer ${token}` }, body: compressed })).status, 415);
    assert.equal(calls(), 0);
  });
});
