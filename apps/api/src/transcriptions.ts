import { Router, type ErrorRequestHandler } from "express";
import multer from "multer";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const formats: Record<string, { mime: string[]; header: (b: Buffer) => boolean }> = {
  ".wav": { mime: ["audio/wav", "audio/wave", "audio/x-wav"], header: b => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" },
  // curl can label MP3 files as generic binary; still require the MP3 signature below.
  ".mp3": { mime: ["audio/mpeg", "audio/mp3", "application/octet-stream"], header: b => b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  ".m4a": { mime: ["audio/mp4", "audio/x-m4a"], header: b => b.toString("ascii", 4, 8) === "ftyp" },
  ".ogg": { mime: ["audio/ogg"], header: b => b.toString("ascii", 0, 4) === "OggS" },
  ".flac": { mime: ["audio/flac", "audio/x-flac"], header: b => b.toString("ascii", 0, 4) === "fLaC" },
  ".webm": { mime: ["audio/webm", "video/webm"], header: b => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
};

class TranscriptionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type Transcribe = (file: Express.Multer.File) => Promise<string>;

type Diagnostic = {
  event: "groq_transcription_failure";
  diagnosticId: string;
  category: "configuration" | "authentication" | "rate_limit" | "audio_rejected" | "upstream_http" | "invalid_response" | "timeout" | "network" | "application";
  elapsedMs: number;
  upstreamStatus?: number;
  networkCode?: string;
};
const networkCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

export function createGroqTranscriber(options: { apiKey?: () => string | undefined; fetch?: typeof fetch; log?: (diagnostic: Diagnostic) => void } = {}): Transcribe {
  return async file => {
    const started = Date.now();
    const diagnosticId = randomUUID();
    const log = (category: Diagnostic["category"], extra: Pick<Diagnostic, "upstreamStatus" | "networkCode"> = {}) => {
      // Never log the error object, provider body, headers, file or transcript.
      const diagnostic: Diagnostic = { event: "groq_transcription_failure", diagnosticId, category, elapsedMs: Date.now() - started, ...extra };
      (options.log ?? (entry => console.error(JSON.stringify(entry))))(diagnostic);
    };
    const key = (options.apiKey ?? (() => process.env.GROQ_API_KEY))()?.trim();
    if (!key) {
      log("configuration");
      throw new TranscriptionError(503, "Transcription service is not configured.");
    }
    let phase: "request" | "network" | "response" = "request";
    try {
      const form = new FormData();
      // Use a generated filename rather than forwarding the user's original name.
      form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), `audio${extname(file.originalname).toLowerCase()}`);
      form.append("model", "whisper-large-v3-turbo");
      form.append("response_format", "json");
      phase = "network";
      const response = await (options.fetch ?? fetch)("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        log(response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : response.status === 400 || response.status === 422 ? "audio_rejected" : "upstream_http", { upstreamStatus: response.status });
        await response.body?.cancel().catch(() => {});
        if (response.status === 400 || response.status === 422) throw new TranscriptionError(422, "Audio could not be transcribed. Try another recording.");
        if (response.status === 429) throw new TranscriptionError(503, "Transcription service is busy. Try again later.");
        throw new TranscriptionError(502, "Transcription service failed.");
      }
      phase = "response";
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") {
        log("invalid_response", { upstreamStatus: response.status });
        throw new TranscriptionError(502, "Transcription service returned an invalid response.");
      }
      return result.text;
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && networkCodes.has(cause.code) ? cause.code : undefined;
      if ((error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) || code?.includes("TIMEOUT") || code === "ETIMEDOUT") {
        log("timeout", { networkCode: code });
        throw new TranscriptionError(504, "Transcription service timed out.");
      }
      log(phase === "response" ? "invalid_response" : phase === "request" ? "application" : "network", { networkCode: code });
      throw new TranscriptionError(502, "Transcription service failed.");
    }
  };
}

export function transcriptionRouter(transcribe: Transcribe = createGroqTranscriber()) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, callback) => {
      const format = formats[extname(file.originalname).toLowerCase()];
      if (!format || !format.mime.includes(file.mimetype.toLowerCase())) {
        callback(new TranscriptionError(415, "Unsupported audio type. Use WAV, MP3, M4A, OGG, FLAC or WebM."));
      } else callback(null, true);
    },
  }).single("file");
  router.post("/", (req, res, next) => {
    if (!req.is("multipart/form-data")) return next(new TranscriptionError(400, "Send multipart/form-data with one audio file in the file field."));
    upload(req, res, error => {
      if (error) {
        if (error instanceof TranscriptionError) return next(error);
        return next(new TranscriptionError(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? "Audio must be 10 MiB or smaller." : "Invalid upload. Send exactly one audio file in the file field and no other fields."));
      }
      next();
    });
  }, async (req, res) => {
    const file = req.file;
    if (!file || file.size === 0) throw new TranscriptionError(400, "A nonempty audio file is required.");
    if (!formats[extname(file.originalname).toLowerCase()].header(file.buffer)) throw new TranscriptionError(415, "File contents do not match the audio type.");
    if (extname(file.originalname).toLowerCase() === ".mp3") file.mimetype = "audio/mpeg";
    res.json({ transcript: await transcribe(file) });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof TranscriptionError ? error.status : 502)
      .json({ error: error instanceof TranscriptionError ? error.message : "Transcription service failed." });
  };
  router.use(errors);
  return router;
}
