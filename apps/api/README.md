# Tova API

**Deployment readiness update:** see [DEPLOYMENT.md](../../DEPLOYMENT.md) for the
current protected demo entry point, required demo credentials, production CORS,
TLS and build commands. The localhost-only/no-auth statements below describe
earlier milestones. The executable API now requires demo access configuration
in development as well as production; it defaults to binding `0.0.0.0` (set
`HOST=127.0.0.1` for local-only use). No remote migrations are run by builds.

Run `npm run dev -w api` from the repository root. The API binds only to
`127.0.0.1` (port 4000 by default). Keep it local while authentication is absent;
do not publish it through a tunnel or reverse proxy.

## Create a manual sale

`POST http://127.0.0.1:4000/sales`, with `Content-Type: application/json`:

```json
{
  "items": [
    { "name": "Rice", "quantity": 2, "unit": "bag", "unitPrice": "25000.00" },
    { "name": "Soap", "quantity": 3, "unit": "pack", "piecesPerUnit": 6, "unitPrice": "500.00" }
  ]
}
```

All amounts are NGN. Prices must be positive decimal strings with at most two
decimal places; quantities and optional pieces-per-unit must be positive
32-bit integers. Package size never affects the calculation. Requests accept
1–100 items, names up to 200 characters, and units up to 50 characters.
Unknown fields are rejected, including totals, timestamps and recording IDs.

The server calculates each line total and the sale total using Prisma Decimal,
then saves the sale and all items atomically. Every saved manual sale is
confirmed; it has no recording. The database supplies the current sale time.
Amounts must fit Decimal(14,2).

Success returns HTTP 201 with the sale and its items. Money values are JSON
strings (trailing zeros may be omitted). Invalid input returns 400, oversized
bodies return 413, and unexpected failures return a generic 500 error without
database details.

The shared Prisma client uses `DATABASE_URL` and preserves its strict TLS/CA
settings. Generate it when needed from `apps/api`:

```powershell
npx prisma generate --config prisma7.config.ts
```

Checks from the repository root:

```powershell
npm run build -w api
npm test -w api
```

Tests cover validation, decimal calculations, and HTTP multi-item creation using
an injected database substitute; they do not insert records into Supabase.

## Transcribe a short audio recording

Set `GROQ_API_KEY` in the server's `apps/api/.env` (never in frontend code).
Restart the API after changing environment settings. From the repository root,
run `npm run dev -w api`. If a previous API process is still using port 4000,
stop it first. For a compiled server, run `npm run build -w api` then
`npm run start -w api`.

Record a short spoken sentence on your phone, such as "Two gowns at eight
thousand naira each", and transfer the recording to your computer. Use a WAV,
MP3, M4A, OGG, FLAC or WebM file, no larger than 10 MiB. This is a byte limit,
not an enforced duration limit. Send it from PowerShell:

```powershell
curl.exe -i http://127.0.0.1:4000/transcriptions -F "file=@C:/path/to/recording.m4a;type=audio/mp4"
```

Use `type=audio/wav` for WAV, `audio/mpeg` for MP3, `audio/ogg` for OGG,
`audio/flac` for FLAC, or `audio/webm` for WebM. Do not manually set the request's
Content-Type header; curl supplies the multipart boundary. Send exactly one
file in the `file` field and no additional fields.

Success is HTTP 200 with `{"transcript":"..."}`. The endpoint uses Groq's
official `/openai/v1/audio/transcriptions` API and `whisper-large-v3-turbo`:
https://console.groq.com/docs/speech-to-text

The upload stays in memory and is sent to Groq for processing; it is not saved
to disk or Supabase. Extension, MIME type and container header are checked
locally; Groq handles full decoding and rejects unusable audio. A header check
does not guarantee that the file contains decodable speech.

Errors: 400 for missing/empty/malformed uploads or extra fields/files, 413 for
oversized files, 415 for unsupported/mismatched types, 422 for audio Groq cannot
process, 503 for missing configuration or upstream rate limiting, 502 for other
provider/network failures, and 504 after a 30-second upstream timeout. Provider
error bodies and credentials are never returned. Requests are not retried
automatically. Missing configuration leaves the sales endpoint available.

On transcription failures, the API writes one structured diagnostic to server
stderr: a generated diagnostic ID, elapsed milliseconds, failure category,
upstream HTTP status when available, and an allowlisted network error code.
Categories distinguish configuration, authentication, rate limiting, rejected
audio, upstream HTTP errors, invalid responses, timeouts, network and local
request-construction failures. A connection timeout also returns HTTP 504.
No credentials, authorization headers, filenames, audio, transcripts, raw errors
or provider response bodies are logged. Use these diagnostics when reporting
failures; do not paste `.env` contents or raw network traces.

`npm test -w api` also exercises multipart validation and mocked Groq success,
configuration, timeout and failure responses. These tests do not call Groq or
use credits. The curl command above is the manual real-recording check and
uses your Groq account. The server remains bound to localhost only.

## Extract an editable sales draft

`POST /sales/extract` accepts only a JSON `transcript` string (1–8000 characters).
It uses the same server-side `GROQ_API_KEY`, native fetch integration and safe
diagnostic approach as transcription. No additional dependency is required.
Groq's `openai/gpt-oss-20b` model is requested with strict JSON-schema output:
https://console.groq.com/docs/structured-outputs

PowerShell example (no database writes):

```powershell
$body = @{ transcript = '2 dozens of gowns at NGN 24,000 per dozen' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/sales/extract -ContentType 'application/json' -Body $body
```

The response is an editable draft:

```json
{
  "currency": "NGN",
  "requiresReview": true,
  "items": [{ "name": "gowns", "quantity": 2, "unit": "dozen", "unitPrice": "24000.00", "lineTotal": "48000.00" }],
  "totalAmount": "48000.00",
  "issues": []
}
```

Extraction covers wholesale goods, including clothing and food. Explicit units
such as bags, cartons and dozens take precedence over each/apiece: those words
refer to each stated selling unit, not automatically to pieces. Missing prices
remain null and require review; no unit price is inferred from a combined total.

Selling units are preserved (dozens are not converted into pieces). Prices and
totals are decimal strings, calculated on the server using Prisma Decimal.
All model fields are runtime-validated, and each populated field must have
matching evidence from the transcript (case-only differences are accepted;
numbers must still match the cited words). Missing, ambiguous or
unsupported fields become null with an issue containing `itemIndex` (zero-based,
or null for the whole draft), `field` and `code`. Incomplete items have null line
totals; any review issue leaves the grand total null, rather than showing a
misleading partial total. Values outside the existing sale monetary bounds are
flagged for review. Up to 30 extracted items are supported; larger or truncated
responses fail safely.

The prompt forbids guessing missing facts, converting wholesale units, inferring
unit prices from combined totals, or following instructions in transcripts.
Evidence checks reduce unsupported claims but cannot prove the model understood
every phrase or included every item. Review is always required, even when the
issues list is empty. Unsupported number phrases stay null for review.
After editing and confirming a draft, a caller may separately submit only the
accepted item fields to `POST /sales`. Extraction never saves or confirms a sale.

Invalid requests return 400; invalid model output, network/provider failures or
refusals return 502; missing configuration/rate limits return 503; timeouts return
504. Safe `groq_extraction_failure` logs contain only a generated diagnostic ID,
category and optional HTTP status, never transcripts, model output or keys.
Extraction tests mock Groq and forbid database writes.


## Milestone 2: local sales reads and retry-safe confirmation

The API remains bound to `127.0.0.1:4000`. CORS supports only
`http://localhost:3010`, `http://127.0.0.1:3010` and the equivalent port-3000
origins, including preflight for Content-Type and Idempotency-Key. There is no
authentication or tenant isolation: this is one local development business.
Do not expose these read/write routes publicly or behind a public proxy.

- `GET /sales?limit=20&cursor=<last-sale-id>` returns `{ sales, nextCursor }`.
  Limits are 1-50. Ordering is soldAt descending, then ID descending. Each sale
  includes items; amounts serialize as strings. Cursor pagination is live,
  not a frozen report snapshot.
- `GET /sales/summary` returns `{ date, timeZone: "Africa/Lagos", totalAmount,
  saleCount }`. The total/count are an aggregate of all sales with soldAt in
  today's Lagos midnight-to-midnight half-open interval, not a page of history.
  Nigeria uses UTC+01:00 year-round. Empty totals are `"0.00"` and 0.
- `POST /sales` retains its existing item body. Send a UUID v4
  `Idempotency-Key` header for retry-safe creation. That UUID becomes Sale.id;
  the existing primary-key constraint serializes concurrent attempts. A replay
  returns the saved sale if the normalized item multiset matches, or 409 if it
  differs. Server totals remain authoritative. A 201 replay creates no new rows.
  The header remains optional for legacy callers; requests without it have no
  deduplication guarantee. Frontend confirmations always send it.

No schema changes, new dependencies, migrations or background jobs were added.
Browser `audio/mp4` is uploaded as `.m4a`; existing ftyp validation still applies.
The frontend base URL is configured through its public NEXT_PUBLIC_API_BASE_URL;
Groq and database secrets stay exclusively in apps/api/.env.

## Product catalogue (Milestone 1)

The catalogue introduces stable product UUIDs without changing recorded item
names. `Product` stores the canonical name. `ProductAlias` is a shared name
registry: product creation reserves its canonical name there (`isCanonical`
is true), and explicitly confirmed aliases use the same unique normalized key.
Both records are created in one transaction, so canonical names and aliases
cannot claim a name already owned by another product. Canonical reservations
are omitted from the public alias list. Write catalogue records through these
operations rather than inserting products directly without their reservation.

Names use Unicode NFKC normalization, trimmed/collapsed whitespace and lowercase
keys for exact matching. Display casing is retained. Punctuation, accents,
plurals and brand words are not removed: `Nike sneakers` is unknown until that
exact normalized name is explicitly registered, even if `Sneakers` exists.
Names must contain 1-200 visible characters. There is no fuzzy matching, AI
merging, automatic alias creation, renaming or deletion endpoint.

Operations use the existing localhost-only API and JSON bodies:

| Operation | Request | Response |
| --- | --- | --- |
| List | `GET /products?limit=20&cursor=<last-product-id>` | `{ products: [{ id, canonicalName, createdAt, aliases: [{ id, name }] }], nextCursor }` |
| Create | `POST /products` with `{ "canonicalName": "Sneakers" }` | 201 with `{ id, canonicalName, createdAt, aliases: [] }` |
| Resolve | `POST /products/resolve` with `{ "names": ["Sneakers", "Nike sneakers"] }` | `{ matches: [{ name, normalizedName, matched, matchType, product }] }` |
| Confirm alias | `POST /products/<product-id>/aliases` with `{ "name": "Nike sneakers", "confirmed": true }` | 201 with `{ registration: { id, productId, name, kind }, created: true }` |

List limits are 1-50, ordered by stable ID. Resolution accepts 1-100 names,
preserves input order, and never writes. Matches have `matchType` of `canonical`
or `alias` and `product: { id, canonicalName }`; unknown names have null for both.
Confirming an already-owned name returns 200 with `created: false`, including a
canonical name whose `kind` is `canonical`. Cross-product name conflicts return
409. Invalid input or missing explicit confirmation returns 400; a missing
target product returns 404. Unexpected failures return a generic 500 with only
an allowlisted database error code logged server-side.

`POST /sales` additionally accepts an optional `productId` UUID (or null) per
item. The caller must explicitly select the product; even an existing confirmed
alias does not cause automatic linkage during saving. The referenced product
must exist. `name` still stores the original reviewed item name, and prices,
units and totals retain their existing behavior. The product selection is part
of the idempotency comparison. Legacy callers may omit it and continue saving
unlinked items. Existing sales reads include the new nullable `productId`.
Extraction and transcription do not read or write the catalogue.

### Catalogue migration deployment

`prisma/migrations/20261022090000_product_catalogue/migration.sql` creates the
catalogue tables, indexes and nullable foreign key. It contains no historical
data updates, deletion or backfill. Existing item product IDs remain null.
Linked products cannot be deleted while sale items reference them.

The development Supabase migration was applied successfully by the user before
the review integration milestone. For another database that does not yet have
it, run these commands from `apps/api` to apply checked-in migrations and
regenerate the client:

```powershell
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
```

Then build from the repository root with `npm run build -w api` and restart the
API using the existing scripts. New Prisma queries expect the nullable column,
so apply the migration before starting the updated API. The additive DDL still
needs database locks and an index scan; schedule a quiet development window.
It runs in a transaction with a 5-second lock timeout and 60-second statement
timeout, rolling back on failure rather than leaving partial schema changes.
If Prisma records a failed migration, inspect its status and confirm rollback
before using Prisma's failed-migration recovery process; do not reset the DB.

Catalogue regression tests use an injected transactional database substitute
and local HTTP server. They cover normalization, canonical/alias conflicts,
rollback, explicit confirmation, unknown names, historical item preservation,
explicit sale linking, idempotency and legacy API compatibility. Schema
validation and migration SQL inspection do not replace applying and verifying
the migration against PostgreSQL. No test sales or catalogue records are
inserted into Supabase by these tests. The frontend now integrates product
selection and alias confirmation using these existing contracts: extraction is
followed by a separate batch resolution call, and sale items send the selected
product UUID while retaining their reviewed name. New UI reviews require a
match; legacy API callers can still omit product IDs. An HTTP regression test
drives the actual frontend client and flow through Express with an in-memory
database, including lost-response recovery and unchanged historical items.
Categories, brands, inventory, variants, analytics and historical backfill
remain outside this milestone.
