# Tova frontend - Milestone 2

**Deployment readiness update:** see [DEPLOYMENT.md](../../DEPLOYMENT.md).
The frontend now requires a temporary demo unlock before business screens mount.
The older localhost-only/no-auth descriptions below are historical. Production
builds require an explicit HTTPS `NEXT_PUBLIC_API_BASE_URL`; backend credentials
and signing secrets must never be supplied to the frontend.

The existing Next.js / Tailwind interface now supports record -> transcription -> extraction -> editable review -> explicit confirmation -> saved sales/history. No recording is automatically saved as a sale.

## Local setup

From the repository root, in separate terminals:

```powershell
npm run dev -w api
npm run dev -w web
```

Open http://localhost:3010. Both servers bind to loopback. The API is http://127.0.0.1:4000. The web scripts default to port 3010.

`apps/api/.env` contains the existing `DATABASE_URL`, `DIRECT_URL` and `GROQ_API_KEY`. Never copy them into frontend configuration. The schema and migrations have not changed for this milestone.

Optional frontend configuration in `apps/web/.env.local` (see `.env.example`):

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000
```

This is a public URL, not a secret. Next.js bundles it at build time; restart development or rebuild production after changing it. For compiled apps:

```powershell
npm run build -w api
npm run build -w web
npm run start -w api
npm run start -w web
```

CORS allows only localhost/127.0.0.1 on ports 3000 and 3010 and the required Content-Type/Idempotency-Key headers. This is a **single-business, local development MVP without authentication**. CORS is not access control. Do not publish these APIs or proxy them onto a public/multi-user deployment until authentication, ownership and authorization are implemented. Microphone access requires localhost or a trusted HTTPS context; a plain HTTP phone LAN URL is insufficient.

## Code boundaries

- `components/ui/` and `components/layout/`: existing visual primitives, shell and navigation. Branding and visual hierarchy are preserved.
- `lib/api/contracts.ts`: actual API types and runtime response validation.
- `lib/api/client.ts`: bounded typed fetch calls, error handling, multipart construction and public base URL.
- `features/recording/`: native recorder lifecycle, hook and existing screen, now connected to processing.
- `features/sales/sales-flow.ts`: local orchestration, retained transcript/draft, exact-payload retry and session restoration; tested independently of React.
- `features/sales/review.ts`: controlled form rows, strict validation, BigInt integer-cent arithmetic, formatting and exact save payload construction.
- `features/sales/components/`: review, saved confirmation, real summaries/lists/history, and a small session provider shared across routes.
- `features/sales/hooks/`: read loading/error/retry, focus/minute refresh, pagination and save-triggered refresh.
- `app/`: thin route composition for `/`, `/record`, `/review`, `/history`.

There are no new dependencies or global state libraries. The persistent layout owns one local session because audio and review now genuinely span routes. Static page content remains server-rendered; interactive feature components stay client-side.

## Contracts and behavior

1. Continue sends a nonempty recording as multipart `file` to `POST /transcriptions`, without setting the multipart Content-Type manually. Codecs are removed from the part MIME, not from the audio bytes. Browser MP4 audio is named `.m4a` with `audio/mp4`; WebM and Ogg retain their actual container. The backend's signature/size checks remain intact.
2. `{ transcript }` is sent to `POST /sales/extract`. The original transcript, nullable draft fields, `requiresReview`, and original structured warnings are retained. Failed extraction retries reuse the successful transcript rather than charging for transcription again.
3. Review shows controlled item name, quantity, selling unit and price inputs. Missing values are blank, never zero. Add/remove items as needed. Wholesale units are not converted. Original warnings remain visible; confirm the review checkbox after correcting them.
4. Client totals use BigInt cents (ES2020) and match the backend's positive-value/Decimal(14,2) limits. Only `{ items: [{ name, quantity, unit, unitPrice }] }` is sent to `POST /sales`; the backend recalculates all totals with Prisma Decimal.
5. Confirm and Save sends a UUID v4 `Idempotency-Key`. The backend uses that UUID as the Sale primary key, so concurrent requests and lost-response retries create one sale. Reusing a key for changed items returns 409. No new table or migration is required. Legacy API calls without the optional header retain their previous behavior and are not retry-safe.
6. On an uncertain save failure, fields are locked to the original payload. Retry uses the same key and payload until the outcome is known, rather than accidentally inserting an edited second sale. Do not clear tab storage during an unresolved save.
7. Home reads `GET /sales/summary` and recent `GET /sales?limit=5`. History pages through `GET /sales?limit=20&cursor=...`. Daily totals use `soldAt` and the half-open Africa/Lagos business day (UTC+01:00 year-round), independent of the host timezone. Reads never infer totals from one paginated page.

## Audio and draft lifecycle

Audio remains in memory, never localStorage/sessionStorage. The recorder lives in the persistent layout, so navigating between Home/Record/History preserves a stopped recording. Navigating away during capture finishes recording and releases the microphone. The original 2-minute/10-MiB limits and background/unmount cleanup remain.

Draft text, controlled fields, and a pending save key/payload are stored in **tab-scoped sessionStorage** to recover refreshes and ambiguous save results. This includes potentially sensitive sale text; it is cleared on discard or successful save, and normal tab closure clears session storage. Audio URLs are revoked when replaced/cancelled/saved. A reload warning protects unsaved audio, which cannot be recovered after refresh. Restored pending saves must be retried with their original identity. Starting a new recording asks before discarding an existing unsaved draft.

Session storage must be available before saving. Audio is sent to Groq for transcription; the transcript is sent to Groq for extraction. Audio and transcripts are not written to Supabase by this flow. Only reviewed item data is persisted after explicit confirmation.

## Verification

```powershell
npm run lint -w web
npm run typecheck -w web
npm test -w web
npm test -w api
npm run build -w api
npm run build -w web
```

Tests use the existing Node/TypeScript runners, with fake network/database services for unit and HTTP checks. They cover multipart MIME/extensions, nullable contracts, exact totals, wholesale units, invalid forms, payload fields, processing retries, lost save responses/session restoration, Lagos boundaries, paginated reads, CORS and idempotency races. `typecheck` runs without incremental cache to avoid sharing stale diagnostics with a concurrent Next dev/build process.

Manual integration: record a clearly labelled test sale, Continue, inspect the transcript and draft, correct fields, acknowledge review, save once, then check Home and History. Test server outage/retry and navigation retention. A real save inserts a development record; unit tests do not. Browser automation with synthetic speech can exercise the real Groq/Supabase path, but does not replace physical microphone testing or prove extraction accuracy for arbitrary speech.

## Remaining limits

Local single-business use only; no authentication or tenant ownership. Drafts are per-tab, not shared across devices. Forced storage clearing or bypassing idempotency can still produce duplicates. Authentication, production data access, cross-device drafts and broader speech-format/language support require future work. Model output always needs human review.


## Catalogue matching and sale review

After extraction, the client batches nonempty item names through
`POST /products/resolve`. The Groq extraction contract is unchanged: matching
is deterministic and separate from the model. A known canonical name or
confirmed alias displays its canonical product below the editable item name.
Selecting a product never replaces that recorded name.

For unknown names, the review offers **Add to catalogue** defaulting to that item name,
or **Use existing** with paginated catalogue loading. Each action opens a single
inline form; known products use a compact **Matched to …** indicator. Linking an
unfamiliar name requires checking the explicit alias-confirmation checkbox and
pressing **Use this product**. A different name for a new canonical
product also requires explicit alias confirmation, preserving the recorded name.
Creation and alias registration are separate retry-safe operations; if alias
registration fails after creation, the canonical product remains and retry
recovers its ID instead of creating a duplicate. There is no fuzzy matching or
automatic merging. Product creation and confirmed alias registration persist
immediately, even if the draft is later discarded; they do not create a sale.

Every item in a new review must have a resolved product before saving. Saving
sends its `productId` alongside the existing name, quantity, unit and unitPrice.
Backend decimal calculations and nested writes remain authoritative. Editing
the name clears its selection; leaving the name field checks it again. Empty
or uncertain names must be corrected first. Matching errors retain the draft
and offer retry without repeating transcription or extraction. Stale async
results cannot attach a product after a row is renamed, removed or discarded.

Product-name uniqueness makes duplicate create requests harmless: a 409 is
resolved through an exact catalogue lookup, recovering the existing stable ID
after a lost response. Alias retries for the same product return success;
cross-product conflicts remain errors until a fresh exact lookup confirms the
owner. Failed sale saves retain their original key, exact payload and product
selection, including across refresh. Drafts without a pending save recheck
their catalogue matches on reload. Legacy pending saves retain their old
payload without adding product IDs; historical sales accept null or absent IDs.

The existing `/products` and `/sales` contracts suffice; no new dependencies,
API routes or schema migration are needed. The already-applied product catalogue
migration is required. Start the current API and frontend using their existing
localhost-only scripts. Regression tests use fake services and an actual local
Express server backed by in-memory delegates, never live Supabase writes.
They cover matching, uncertainty, stale responses, creation/alias conflicts,
pagination, refresh, lost responses, historical data and sale payloads.
Production/local microphone testing with an existing catalogue remains a manual
verification step; intentionally saving a real sale is outside this test run.

## Milestone 2 verification results (prior milestone)

Final checks passed: frontend lint, TypeScript, frontend production build,
backend TypeScript build, 15 frontend tests and 23 backend tests. Isolated Chrome
with synthetic microphone input verified real multipart upload handling,
processing error/retry feedback, editable review, navigation retention, restored
review edits after reload, phone/desktop layouts, and real persisted sales reads.

The live Groq attempt failed twice with the safe network diagnostic ENOTFOUND
(DNS lookup failure), so a fully live Groq end-to-end pass was **not** established
in this run. A temporary server injected provider fixtures for the remaining
browser integration checks, while using the real Express routes and Supabase.
Those provider fixtures were removed and the normal API restored afterward.

One clearly labelled development test sale remains:
`365a956b-06f2-4f26-83d8-91cb626201d6` (INTEGRATION TEST M2 gowns/jeans), with
2 associated items totalling NGN 70500.00. After the browser save initially
returned a transient failure, a direct same-key diagnostic save established that
record. Subsequent browser replay checks deliberately dropped a successful
response, recovered with the same key/payload, and created no additional rows.
Prisma independently verified the one sale, quantities, wholesale units, prices
and line totals. Home and History displayed the real saved record. The incomplete
live Groq check remains an explicit environment limitation, not a claimed pass.
