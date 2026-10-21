import { object, parseDraft, parseSale, parseSalesPage, parseSummary, type SalePayload } from "./contracts.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export function audioUpload(blob: Blob) {
  const type = blob.type.split(";")[0].trim().toLowerCase();
  const formats: Record<string, string> = { "audio/webm": "webm", "video/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };
  const extension = formats[type];
  if (!extension || !blob.size || blob.size > 10 * 1024 * 1024) throw new Error("This audio format or size is unsupported. Please make a shorter recording in a supported browser.");
  const form = new FormData();
  // Strip codec parameters for the backend allowlist; preserve the real container.
  form.append("file", new Blob([blob], { type }), `recording.${extension}`);
  return form;
}
export function createApi(baseUrl: string, request: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, "");
  async function call(path: string, init?: RequestInit) {
    let response: Response;
    try { response = await request(`${base}${path}`, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(75_000) }); }
    catch { throw new ApiError("Unable to reach Tova. Check that the API is running and try again.", 0); }
    if (!response.ok) {
      // Only display bounded application messages, never HTML, stack traces or headers.
      let message = `Request failed (${response.status}). Please try again.`;
      try { const value = object(await response.json()); if (typeof value.error === "string" && value.error.length < 300) message = value.error; } catch {}
      throw new ApiError(message, response.status);
    }
    try { return await response.json() as unknown; }
    catch { throw new ApiError("Tova returned an unreadable response. Please retry.", 502); }
  }
  return {
    async transcribe(blob: Blob) {
      const value = object(await call("/transcriptions", { method: "POST", body: audioUpload(blob) }));
      if (typeof value.transcript !== "string" || !value.transcript.trim() || value.transcript.length > 8000) throw new ApiError("No usable speech was found. Record the sale again.", 422);
      return value.transcript;
    },
    async extract(transcript: string) { return parseDraft(await call("/sales/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) })); },
    async save(payload: SalePayload, key: string) { return parseSale(await call("/sales", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) })); },
    async sales(cursor?: string, limit = 20) { return parseSalesPage(await call(`/sales?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)); },
    async summary() { return parseSummary(await call("/sales/summary")); },
  };
}
export const api = createApi(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4000");
