import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { createSale, IdempotencyConflict, ValidationError, type SaleWriter } from "./sales.js";
import { salesSummary, type SaleReader } from "./sales-read.js";
import { transcriptionRouter, type Transcribe } from "./transcriptions.js";
import { extractionRouter, type Extract } from "./extraction.js";
import { catalogueRouter, type CatalogueClient } from "./catalogue.js";
import { databaseFailure } from "./database-diagnostics.js";

export function createApp(db: SaleWriter & { sale: Partial<SaleReader["sale"]> } & Partial<CatalogueClient>, transcribe?: Transcribe, extract?: Extract, localCors = true) {
  const app = express();
  if (localCors) app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3010", "http://127.0.0.1:3010"], allowedHeaders: ["Content-Type", "Idempotency-Key"] }));
  app.use(express.json({ limit: "64kb", inflate: false }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "tova-api" }));
  app.use("/transcriptions", transcriptionRouter(transcribe));
  app.use("/sales/extract", extractionRouter(extract));
  app.use("/products", catalogueRouter(db));
  app.get("/sales/summary", async (_req, res) => {
    if (!db.sale.aggregate) return res.status(503).json({ error: "Sales reads are unavailable." });
    res.set("Cache-Control", "no-store").json(await salesSummary({ sale: { aggregate: db.sale.aggregate } }));
  });
  app.get("/sales", async (req, res) => {
    const { limit = "20", cursor } = req.query;
    if (Object.keys(req.query).some(k => !["limit", "cursor"].includes(k)) || typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 || (cursor !== undefined && (typeof cursor !== "string" || !/^[0-9a-f-]{36}$/i.test(cursor)))) throw new ValidationError("Invalid sales pagination.");
    if (!db.sale.findMany) return res.status(503).json({ error: "Sales reads are unavailable." });
    const sales = await db.sale.findMany({ take: Number(limit) + 1, ...(typeof cursor === "string" ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ soldAt: "desc" }, { id: "desc" }], include: { items: true } });
    const hasMore = sales.length > Number(limit);
    const page = sales.slice(0, Number(limit));
    res.set("Cache-Control", "no-store").json({ sales: page, nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });
  app.post("/sales", async (req, res) => {
    const sale = await createSale(db, req.body, req.get("Idempotency-Key"));
    // Prisma Decimal.toJSON returns strings, never floating-point amounts.
    res.status(201).json(sale);
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof IdempotencyConflict) {
      res.status(409).json({ error: error.message });
    } else if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
    } else if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON body." });
    } else if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large." });
    } else if (error?.type === "encoding.unsupported") {
      res.status(415).json({ error: "Compressed JSON bodies are unsupported." });
    } else {
      console.error(JSON.stringify({ event: "sales_request_failed", operation: _req.method === "GET" ? "read" : "write", ...databaseFailure(error) }));
      res.status(500).json({ error: _req.method === "GET" ? "Unable to load sales." : "Unable to create sale." });
    }
  };
  app.use(errors);
  return app;
}
