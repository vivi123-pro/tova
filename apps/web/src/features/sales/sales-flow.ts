import { object, parseDraft, type Sale, type SalePayload, type SalesDraft } from "../../lib/api/contracts.ts";
import { draftRows, validateReview, type ReviewRow } from "./review.ts";

export type FlowState = {
  phase: "idle" | "transcribing" | "extracting" | "review" | "error" | "saving" | "save-error" | "saved";
  transcript: string; draft: SalesDraft | null; rows: ReviewRow[]; error: string | null;
  attempt: { key: string; payload: SalePayload } | null; savedSale: Sale | null;
};
export const EMPTY_FLOW: FlowState = { phase: "idle", transcript: "", draft: null, rows: [], error: null, attempt: null, savedSale: null };
type Services = { transcribe: (blob: Blob) => Promise<string>; extract: (transcript: string) => Promise<SalesDraft>; save: (payload: SalePayload, key: string) => Promise<Sale> };
type Persistence = { read: () => string | null; write: (value: string | null) => void };
export function createSalesFlow(services: Services, persistence?: Persistence, onSaved?: () => void) {
  let state: FlowState = EMPTY_FLOW;
  let generation = 0;
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
        return { id: string("id"), name: string("name"), quantity: string("quantity"), unit: string("unit"), unitPrice: string("unitPrice") };
      });
      let attempt: FlowState["attempt"] = null;
      if (value.attempt !== null) {
        const pending = object(value.attempt);
        const reviewed = validateReview(rows);
        if (typeof pending.key !== "string" || !/^[0-9a-f-]{36}$/i.test(pending.key) || !reviewed.payload || JSON.stringify(pending.payload) !== JSON.stringify(reviewed.payload)) return;
        attempt = { key: pending.key, payload: reviewed.payload };
      }
      publish({ transcript: value.transcript, draft, rows, attempt, phase: attempt ? "save-error" : draft ? "review" : "error", error: attempt ? "A previous save needs confirmation. Retry safely to recover its result." : draft ? null : "Extraction was interrupted. Retry from your retained transcript." });
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
      publish({ phase: "review", draft, rows: draftRows(draft), error: null });
    } catch (error) { if (current === generation) publish({ phase: "error", error: error instanceof Error ? error.message : "Processing failed. Please retry." }); }
  }
  function updateRows(rows: ReviewRow[]) { if (!state.attempt && state.phase === "review") publish({ rows }); }
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
  return { process, save, reset, restore, updateRows, getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
