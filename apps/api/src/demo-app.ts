import express from "express";
import cors from "cors";
import { createApp } from "./app.js";
import { createDemoAccess, demoConfig, type DemoConfig } from "./demo-access.js";

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env) {
  const origins = (env.CORS_ORIGINS ?? (env.NODE_ENV === "production" ? "" : "http://localhost:3010,http://127.0.0.1:3010,http://localhost:3000,http://127.0.0.1:3000")).split(",").map(v => v.trim()).filter(Boolean);
  if (!origins.length || origins.some(origin => {
    try { const url = new URL(origin); return origin.includes("*") || url.origin !== origin || (env.NODE_ENV === "production" ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)); }
    catch { return true; }
  })) throw new Error("CORS_ORIGINS must be an explicit list of origins (HTTPS in production).");
  return origins;
}

// The executable server mounts ONLY this protected factory. createApp is the injectable business router.
export function createDemoApp(db: Parameters<typeof createApp>[0], options: {
  config?: DemoConfig; origins?: string[]; clock?: () => number;
  transcribe?: Parameters<typeof createApp>[1]; extract?: Parameters<typeof createApp>[2];
} = {}) {
  const access = createDemoAccess(options.config ?? demoConfig(), options.clock);
  const app = express();
  app.disable("x-powered-by");
  // Render terminates TLS and supplies the final proxy hop. Do not use `true`.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(cors({ origin: options.origins ?? allowedOrigins(), allowedHeaders: ["Content-Type", "Idempotency-Key", "Authorization"], methods: ["GET", "POST", "OPTIONS"] }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "tova-api" }));
  app.post("/demo/login", access.loginLimit, express.json({ limit: "2kb", inflate: false }), access.login);
  app.use(access.requireAccess);
  app.use(["/transcriptions", "/sales/extract"], access.limitAi);
  app.use(createApp(db, options.transcribe, options.extract, false));
  app.use(((error, _req, res, _next) => {
    const status = error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : error?.type === "encoding.unsupported" ? 415 : 500;
    res.status(status).json({ error: status === 500 ? "Request failed." : "Invalid unlock request." });
  }) as express.ErrorRequestHandler);
  return app;
}
