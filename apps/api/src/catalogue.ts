import { Router, type ErrorRequestHandler } from "express";
import type { Product, ProductAlias } from "./generated/prisma/client.js";

export class CatalogueError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type RegisteredName = ProductAlias & { product: Product };
type ListedProduct = Product & { names: ProductAlias[] };
export type CatalogueTransaction = {
  product: {
    create: (args: { data: { canonicalName: string } }) => Promise<Product>;
    findUnique: (args: { where: { id: string } }) => Promise<Product | null>;
    findMany: (args: { take: number; cursor?: { id: string }; skip?: number; orderBy: { id: "asc" }; include: { names: { where: { isCanonical: false }; orderBy: { normalizedName: "asc" } } } }) => Promise<ListedProduct[]>;
  };
  productAlias: {
    create: (args: { data: { name: string; normalizedName: string; productId: string; isCanonical: boolean } }) => Promise<ProductAlias>;
    findUnique: (args: { where: { normalizedName: string }; include: { product: true } }) => Promise<RegisteredName | null>;
    findMany: (args: { where: { normalizedName: { in: string[] } }; include: { product: true } }) => Promise<RegisteredName[]>;
  };
};
export type CatalogueClient = CatalogueTransaction & {
  $transaction: <T>(work: (tx: CatalogueTransaction) => Promise<T>) => Promise<T>;
};

export function normalizeProductName(value: unknown) {
  if (typeof value !== "string" || value.length > 1000) throw new CatalogueError(400, "Product names must be strings of 1–200 characters.");
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const normalizedName = name.toLowerCase();
  if (!name || name.length > 200 || normalizedName.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new CatalogueError(400, "Product names must contain 1–200 visible characters.");
  // Deliberately preserve punctuation, accents, plurals and brand words.
  // No stemming, fuzzy matching or AI-generated equivalences.
  return { name, normalizedName };
}
function uniqueConflict(error: unknown) { return !!error && typeof error === "object" && "code" in error && error.code === "P2002"; }
function publicProduct(product: Product) { return { id: product.id, canonicalName: product.canonicalName, createdAt: product.createdAt }; }
function publicName(name: ProductAlias) { return { id: name.id, productId: name.productId, name: name.name, kind: name.isCanonical ? "canonical" : "alias" }; }

export async function createProduct(db: CatalogueClient, canonicalName: unknown) {
  const name = normalizeProductName(canonicalName);
  try {
    return await db.$transaction(async tx => {
      const product = await tx.product.create({ data: { canonicalName: name.name } });
      // A single UNIQUE namespace arbitrates canonical/alias collisions, even
      // across simultaneous requests. A failed reservation rolls back Product.
      await tx.productAlias.create({ data: { ...name, productId: product.id, isCanonical: true } });
      return { ...publicProduct(product), aliases: [] };
    });
  } catch (error) {
    if (uniqueConflict(error)) throw new CatalogueError(409, "That name is already registered in the catalogue.");
    throw error;
  }
}
export async function registerAlias(db: CatalogueClient, productId: string, value: unknown, confirmed: unknown) {
  if (confirmed !== true) throw new CatalogueError(400, "Explicit confirmation is required to register an alias.");
  const name = normalizeProductName(value);
  try {
    const registration = await db.$transaction(async tx => {
      if (!await tx.product.findUnique({ where: { id: productId } })) throw new CatalogueError(404, "Product not found.");
      return tx.productAlias.create({ data: { ...name, productId, isCanonical: false } });
    });
    return { registration: publicName(registration), created: true };
  } catch (error) {
    if (!uniqueConflict(error)) throw error;
    // Read AFTER rollback: PostgreSQL does not allow reads in an aborted tx.
    const existing = await db.productAlias.findUnique({ where: { normalizedName: name.normalizedName }, include: { product: true } });
    if (existing?.productId === productId) return { registration: publicName(existing), created: false };
    throw new CatalogueError(409, "That name is already registered to another product.");
  }
}
export async function resolveProductNames(db: CatalogueTransaction, values: unknown) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new CatalogueError(400, "Provide 1–100 names to resolve.");
  const names = values.map(normalizeProductName);
  const known = await db.productAlias.findMany({ where: { normalizedName: { in: [...new Set(names.map(n => n.normalizedName))] } }, include: { product: true } });
  const byName = new Map(known.map(name => [name.normalizedName, name]));
  return names.map(name => {
    const match = byName.get(name.normalizedName);
    return { name: name.name, normalizedName: name.normalizedName, matched: !!match, matchType: match ? match.isCanonical ? "canonical" : "alias" : null, product: match ? { id: match.product.id, canonicalName: match.product.canonicalName } : null };
  });
}
function body(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CatalogueError(400, "Expected a JSON object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some(field => !(field in result))) throw new CatalogueError(400, "Request contains missing or unsupported fields.");
  return result;
}
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
export function catalogueRouter(candidate: Partial<CatalogueClient>) {
  const router = Router();
  router.use((_req, _res, next) => {
    if (!candidate.product || !candidate.productAlias || !candidate.$transaction) return next(new CatalogueError(503, "Catalogue is unavailable."));
    next();
  });
  function database(): CatalogueClient {
    if (!candidate.product || !candidate.productAlias || !candidate.$transaction) throw new CatalogueError(503, "Catalogue is unavailable.");
    return { product: candidate.product, productAlias: candidate.productAlias, $transaction: candidate.$transaction.bind(candidate) };
  }
  router.get("/", async (req, res) => {
    const { limit = "20", cursor } = req.query;
    if (Object.keys(req.query).some(key => !["limit", "cursor"].includes(key)) || typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 || (cursor !== undefined && !uuid(cursor))) throw new CatalogueError(400, "Invalid product pagination.");
    const products = await database().product.findMany({ take: Number(limit) + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: "asc" }, include: { names: { where: { isCanonical: false }, orderBy: { normalizedName: "asc" } } } });
    const page = products.slice(0, Number(limit));
    res.set("Cache-Control", "no-store").json({ products: page.map(product => ({ ...publicProduct(product), aliases: product.names.map(name => ({ id: name.id, name: name.name })) })), nextCursor: products.length > Number(limit) ? page.at(-1)?.id ?? null : null });
  });
  router.post("/", async (req, res) => {
    const input = body(req.body, ["canonicalName"]);
    res.status(201).json(await createProduct(database(), input.canonicalName));
  });
  router.post("/resolve", async (req, res) => {
    const input = body(req.body, ["names"]);
    res.set("Cache-Control", "no-store").json({ matches: await resolveProductNames(database(), input.names) });
  });
  router.post("/:productId/aliases", async (req, res) => {
    if (!uuid(req.params.productId)) throw new CatalogueError(400, "Invalid product ID.");
    const input = body(req.body, ["name", "confirmed"]);
    const result = await registerAlias(database(), req.params.productId.toLowerCase(), input.name, input.confirmed);
    res.status(result.created ? 201 : 200).json(result);
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof CatalogueError) return res.status(error.status).json({ error: error.message });
    const code = error && typeof error === "object" && typeof error.code === "string" && /^P\d{4}$/.test(error.code) ? error.code : "unknown";
    console.error(JSON.stringify({ event: "catalogue_request_failed", code }));
    res.status(500).json({ error: "Unable to complete the catalogue request." });
  };
  router.use(errors);
  return router;
}
