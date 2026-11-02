import { object, parseDraft, parseProduct, type ProductMatch, type ProductRef, type Sale, type SalePayload, type SalesDraft } from "../../lib/api/contracts.ts";
import { draftRows, validateReview, type ReviewRow } from "./review.ts";

export type FlowState = {
  phase: "idle" | "transcribing" | "extracting" | "review" | "error" | "saving" | "save-error" | "saved";
  transcript: string; draft: SalesDraft | null; rows: ReviewRow[]; error: string | null;
  attempt: { key: string; payload: SalePayload } | null; savedSale: Sale | null;
};
export const EMPTY_FLOW: FlowState = { phase: "idle", transcript: "", draft: null, rows: [], error: null, attempt: null, savedSale: null };
type Services = {
  transcribe: (blob: Blob) => Promise<string>; extract: (transcript: string) => Promise<SalesDraft>; save: (payload: SalePayload, key: string) => Promise<Sale>;
  resolveProducts?: (names: string[]) => Promise<ProductMatch[]>;
  createProduct?: (name: string) => Promise<ProductRef>;
  confirmAlias?: (productId: string, name: string) => Promise<void>;
};
type Persistence = { read: () => string | null; write: (value: string | null) => void };
export function createSalesFlow(services: Services, persistence?: Persistence, onSaved?: () => void) {
  let state: FlowState = EMPTY_FLOW;
  let generation = 0;
  const catalogueRequests = new Map<string, symbol>();
  const unchecked = () => ({ status: "unchecked" as const, product: null });
  const reviewRows = (rows: ReviewRow[]) => rows.map(row => ({ ...row, ...(services.resolveProducts ? { catalogue: unchecked() } : {}) }));
  const listeners = new Set<() => void>();
  const serialize = () => state.phase === "saved" || !state.transcript ? null : JSON.stringify({ transcript: state.transcript, draft: state.draft, rows: state.rows, attempt: state.attempt });
  function publish(patch: Partial<FlowState>) {
    state = { ...state, ...patch };
    try { persistence?.write(serialize()); } catch { /* In-memory edits remain available; saving checks durability separately. */ }
    listeners.forEach(listener => listener());
  }
  function reset() {
    if (state.attempt && state.phase !== "saved") return false;
    generation++;
    catalogueRequests.clear();
    publish(EMPTY_FLOW);
    return true;
  }
  function restore() {
    if (state !== EMPTY_FLOW) return;
    try {
      const raw = persistence?.read(); if (!raw) return;
      const value = object(JSON.parse(raw));
      if (typeof value.transcript !== "string" || !value.transcript.trim() || value.transcript.length > 8000 || !Array.isArray(value.rows) || value.rows.length > 100) return;
      const draft = value.draft === null ? null : parseDraft(value.draft);
      const rows = value.rows.map(value => {
        const row = object(value);
        const string = (key: string) => { if (typeof row[key] !== "string" || row[key].length > 500) throw new Error("Invalid session"); return row[key]; };
        let catalogue: ReviewRow["catalogue"];
        if (row.catalogue !== undefined) {
          const stored = object(row.catalogue);
          // In-flight operations must be retried after reload. Only a fixed
          // pending save retains its product selection without fresh resolution.
          catalogue = stored.status === "matched" ? { status: "matched", product: parseProduct(stored.product) } : unchecked();
        }
        return { id: string("id"), name: string("name"), quantity: string("quantity"), unit: string("unit"), unitPrice: string("unitPrice"), ...(catalogue ? { catalogue } : {}) };
      });
      let attempt: FlowState["attempt"] = null;
      if (value.attempt !== null) {
        const pending = object(value.attempt);
        const reviewed = validateReview(rows);
        if (typeof pending.key !== "string" || !/^[0-9a-f-]{36}$/i.test(pending.key) || !reviewed.payload || JSON.stringify(pending.payload) !== JSON.stringify(reviewed.payload)) return;
        attempt = { key: pending.key, payload: reviewed.payload };
      }
      publish({ transcript: value.transcript, draft, rows: attempt ? rows : reviewRows(rows), attempt, phase: attempt ? "save-error" : draft ? "review" : "error", error: attempt ? "A previous save needs confirmation. Retry safely to recover its result." : draft ? null : "Extraction was interrupted. Retry from your retained transcript." });
      if (!attempt && draft) void resolveRows();
    } catch { /* Ignore invalid session data; it is never sent to an API. */ }
  }
  async function process(blob: Blob) {
    if (["transcribing", "extracting", "saving", "save-error"].includes(state.phase) || state.attempt) return;
    const current = ++generation;
    try {
      let transcript = state.transcript;
      if (!transcript) {
        publish({ phase: "transcribing", error: null });
        transcript = await services.transcribe(blob);
        if (current !== generation) return;
        publish({ transcript });
      }
      publish({ phase: "extracting", error: null });
      const draft = await services.extract(transcript);
      if (current !== generation) return;
      publish({ phase: "review", draft, rows: reviewRows(draftRows(draft)), error: null });
      await resolveRows();
    } catch (error) { if (current === generation) publish({ phase: "error", error: error instanceof Error ? error.message : "Processing failed. Please retry." }); }
  }
  function updateRows(rows: ReviewRow[]) {
    if (state.attempt || state.phase !== "review") return;
    const previous = new Map(state.rows.map(row => [row.id, row]));
    const next = rows.map(row => {
      const old = previous.get(row.id);
      if (services.resolveProducts && (!old || old.name !== row.name)) {
        catalogueRequests.delete(row.id);
        return { ...row, catalogue: unchecked() };
      }
      return { ...row, ...(old?.catalogue ? { catalogue: old.catalogue } : {}) };
    });
    for (const id of catalogueRequests.keys()) if (!next.some(row => row.id === id)) catalogueRequests.delete(id);
    publish({ rows: next });
  }
  function setCatalogue(id: string, selection: ReviewRow["catalogue"]) {
    publish({ rows: state.rows.map(row => row.id === id ? { ...row, catalogue: selection } : row) });
  }
  async function resolveRows(rowId?: string) {
    const resolve = services.resolveProducts;
    if (!resolve || state.phase !== "review" || state.attempt) return;
    const rows = state.rows.filter(row => (!rowId || row.id === rowId) && row.name.trim() && row.name.trim().length <= 200 && row.catalogue?.status !== "loading");
    if (!rows.length) return;
    const current = generation;
    const requests = rows.map(row => { const token = Symbol(); catalogueRequests.set(row.id, token); return { row, token }; });
    publish({ rows: state.rows.map(row => rows.some(r => r.id === row.id) ? { ...row, catalogue: { status: "loading", product: null } } : row) });
    const active = (id: string, token: symbol) => generation === current && catalogueRequests.get(id) === token && state.phase === "review" && !state.attempt;
    try {
      const matches = await resolve(rows.map(row => row.name));
      if (matches.length !== requests.length) throw new Error("Invalid product matches. Retry matching.");
      requests.forEach(({ row, token }, index) => {
        if (!active(row.id, token)) return;
        const product = matches[index].product;
        setCatalogue(row.id, { status: product ? "matched" : "unmatched", product });
        catalogueRequests.delete(row.id);
      });
    } catch (error) {
      requests.forEach(({ row, token }) => {
        if (!active(row.id, token)) return;
        setCatalogue(row.id, { status: "error", product: null, error: error instanceof Error ? error.message : "Product matching failed. Retry matching." });
        catalogueRequests.delete(row.id);
      });
    }
  }
  async function catalogueOperation(id: string, work: (name: string) => Promise<ProductRef>) {
    const row = state.rows.find(row => row.id === id);
    if (state.phase !== "review" || state.attempt || !row?.name.trim() || row.catalogue?.status === "loading" || row.catalogue?.status === "matched") return;
    const token = Symbol(); const current = generation;
    catalogueRequests.set(id, token);
    setCatalogue(id, { status: "loading", product: null });
    const active = () => current === generation && catalogueRequests.get(id) === token && state.phase === "review" && !state.attempt;
    try {
      const product = await work(row.name);
      if (active()) setCatalogue(id, { status: "matched", product });
    } catch (error) {
      if (active()) setCatalogue(id, { status: "error", product: null, error: error instanceof Error ? error.message : "Catalogue update failed. Please retry." });
    } finally { if (active()) catalogueRequests.delete(id); }
  }
  async function createRowProduct(id: string, canonicalName?: string, confirmed = false) {
    const create = services.createProduct;
    if (!create) return;
    await catalogueOperation(id, async name => {
      const canonical = canonicalName ?? name;
      // A differently named canonical product needs the same explicit alias
      // confirmation as choosing an existing product. The backend owns matching.
      const different = canonical.trim() !== name.trim();
      if (different && (!confirmed || !services.confirmAlias)) throw new Error("Confirm the recorded name as an alias for this canonical product first.");
      const product = await create(canonical);
      if (different) await services.confirmAlias!(product.id, name);
      return product;
    });
  }
  async function confirmRowAlias(id: string, product: ProductRef, confirmed: boolean) {
    if (!services.confirmAlias || confirmed !== true) return;
    await catalogueOperation(id, async name => {
      await services.confirmAlias!(product.id, name);
      return product;
    });
  }
  async function save() {
    if (!["review", "save-error"].includes(state.phase)) return;
    const validated = validateReview(state.rows);
    if (!validated.payload) return;
    const attempt = state.attempt ?? { key: crypto.randomUUID(), payload: validated.payload };
    publish({ phase: "saving", attempt, error: null });
    try {
      // Persist key + exact payload BEFORE sending. Refresh/retry must reuse them.
      persistence?.write(serialize());
    } catch { publish({ phase: "save-error", error: "Session storage is unavailable. Enable it and retry so your sale can be saved safely." }); return; }
    try {
      const savedSale = await services.save(attempt.payload, attempt.key);
      publish({ phase: "saved", savedSale, error: null });
      onSaved?.();
    } catch (error) {
      // Input validation is a definitive rejection before writing; permit edits.
      // Network/5xx outcomes remain locked to the original retry identity.
      const rejected = !!error && typeof error === "object" && "status" in error && (error.status === 400 || error.status === 422);
      publish({ phase: rejected ? "review" : "save-error", ...(rejected ? { attempt: null } : {}), error: error instanceof Error ? error.message : "Saving failed. Retry to recover the same sale." });
    }
  }
  return { process, save, reset, restore, updateRows, resolveRows, createRowProduct, confirmRowAlias, getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
