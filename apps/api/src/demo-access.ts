import { createHmac, randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { RequestHandler } from "express";

const scrypt = promisify(derive);
const hashPattern = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
export type DemoConfig = { secret: string; users: Record<string, string>; deadline: number; version: string; ttlSeconds: number };

export async function hashPassword(password: string) {
  if (password.length < 16 || password.length > 256) throw new Error("Use a demo password of 16–256 characters.");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

export function demoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  // Errors name settings only; never include their values.
  const secret = env.DEMO_TOKEN_SECRET ?? "";
  if (Buffer.byteLength(secret) < 32) throw new Error("DEMO_TOKEN_SECRET must contain at least 32 bytes.");
  let users: Record<string, string>;
  try { users = JSON.parse(env.DEMO_USERS_JSON ?? ""); } catch { throw new Error("DEMO_USERS_JSON must contain two hashed credentials."); }
  if (!users || Array.isArray(users) || typeof users !== "object" || Object.keys(users).length !== 2 ||
      Object.entries(users).some(([id, hash]) => !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof hash !== "string" || !hashPattern.test(hash)) ||
      new Set(Object.values(users)).size !== 2) throw new Error("DEMO_USERS_JSON must contain two distinct IDs and password hashes.");
  const deadline = Date.parse(env.DEMO_ACCESS_EXPIRES_AT ?? "");
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("DEMO_ACCESS_EXPIRES_AT must be a future ISO timestamp.");
  const ttlSeconds = Number(env.DEMO_TOKEN_TTL_SECONDS ?? 900);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("DEMO_TOKEN_TTL_SECONDS must be between 1 and 3600.");
  const version = env.DEMO_TOKEN_VERSION ?? "1";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(version)) throw new Error("Invalid DEMO_TOKEN_VERSION.");
  return { secret, users, deadline, version, ttlSeconds };
}

// Fixed-window counters are process-local and bounded. Run a single demo instance.
function limiter(max: number, windowMs: number, clock: () => number) {
  const counters = new Map<string, { count: number; until: number }>();
  return (key: string) => {
    const now = clock();
    for (const [id, entry] of counters) if (entry.until <= now) counters.delete(id);
    let entry = counters.get(key);
    if (!entry) {
      if (counters.size >= 1000) return false;
      entry = { count: 0, until: now + windowMs }; counters.set(key, entry);
    }
    return ++entry.count <= max;
  };
}

export function createDemoAccess(config: DemoConfig, clock = Date.now) {
  const loginIp = limiter(10, 600_000, clock);
  const loginGlobal = limiter(30, 600_000, clock);
  const loginUser = limiter(10, 600_000, clock);
  const aiUser = limiter(10, 600_000, clock);
  const aiGlobal = limiter(30, 600_000, clock);
  let loginsInFlight = 0;
  const active = new Map<string, symbol>();
  const dummyHash = `00000000000000000000000000000000:${"0".repeat(128)}`;
  const sign = (body: string) => createHmac("sha256", config.secret).update(body).digest();
  const noAccess = (res: Parameters<RequestHandler>[1]) => res.status(401).json({ error: "Demo access has expired. Unlock again or contact the presenter." });

  const loginLimit: RequestHandler = (req, res, next) => {
    if (clock() >= config.deadline) { noAccess(res); return; }
    if (!loginIp(req.ip ?? "unknown") || !loginGlobal("all") || loginsInFlight >= 2) {
      res.set("Retry-After", "600").status(429).json({ error: "Too many unlock attempts. Try again later." }); return;
    }
    next();
  };
  const login: RequestHandler = async (req, res) => {
    const body = req.body;
    if (!body || typeof body.username !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(body.username) ||
        typeof body.password !== "string" || body.password.length > 256 || Object.keys(body).some(k => !["username", "password"].includes(k))) {
      res.status(400).json({ error: "Enter your demo username and password." }); return;
    }
    if (!loginUser(body.username) || loginsInFlight >= 2) { res.set("Retry-After", "600").status(429).json({ error: "Too many unlock attempts. Try again later." }); return; }
    loginsInFlight++;
    try {
      const stored = Object.hasOwn(config.users, body.username) ? config.users[body.username] : dummyHash;
      const [salt, expected] = stored.split(":");
      const actual = await scrypt(body.password, salt, 64) as Buffer;
      if (!timingSafeEqual(actual, Buffer.from(expected, "hex")) || !Object.hasOwn(config.users, body.username)) {
        res.status(401).json({ error: "Invalid demo credentials." }); return;
      }
      const expiresAt = Math.min(clock() + config.ttlSeconds * 1000, config.deadline);
      if (expiresAt <= clock()) { noAccess(res); return; }
      const payload = Buffer.from(JSON.stringify({ sub: body.username, exp: expiresAt, v: config.version })).toString("base64url");
      res.json({ token: `${payload}.${sign(payload).toString("base64url")}`, expiresAt });
    } catch { res.status(503).json({ error: "Demo unlock is temporarily unavailable." }); }
    finally { loginsInFlight--; }
  };
  const requireAccess: RequestHandler = (req, res, next) => {
    try {
      const header = req.get("Authorization") ?? "";
      if (!header.startsWith("Bearer ") || header.length > 2048 || clock() >= config.deadline) { noAccess(res); return; }
      const parts = header.slice(7).split(".");
      if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) { noAccess(res); return; }
      const [payload, signature] = parts;
      const expected = sign(payload), actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { noAccess(res); return; }
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (typeof value.sub !== "string" || !Object.hasOwn(config.users, value.sub) || value.v !== config.version ||
          !Number.isFinite(value.exp) || value.exp <= clock() || value.exp > config.deadline) { noAccess(res); return; }
      res.locals.demoSubject = value.sub;
      next();
    } catch { noAccess(res); }
  };
  const limitAi: RequestHandler = (_req, res, next) => {
    const id = res.locals.demoSubject as string;
    if (!id) { noAccess(res); return; }
    if (active.size >= 2 || active.has(id) || !aiUser(id) || !aiGlobal("all")) {
      res.set("Retry-After", "600").status(429).json({ error: "Demo processing limit reached. Wait before trying again." }); return;
    }
    const lease = Symbol();
    active.set(id, lease);
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      clearTimeout(cleanup);
      if (active.get(id) === lease) active.delete(id);
    };
    res.once("finish", release);
    // Fetch has a 30s deadline. Keep the lease across disconnects until paid
    // processing has timed out, then recover without leaking a permanent slot.
    res.once("close", () => {
      if (!res.writableFinished) { cleanup = setTimeout(release, 35_000); cleanup.unref(); }
    });
    next();
  };
  return { loginLimit, login, requireAccess, limitAi };
}
