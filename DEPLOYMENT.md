# Restricted demo deployment

This is one shared demo shop for a presenter and one reviewer. There are no roles,
Google login, tenant ownership, or isolated shops. Use synthetic data in a **new
Supabase project**. Do not point this demo at the existing database.

The executable API (`src/index.ts`) mounts `createDemoApp`, which protects all
business routes before JSON parsing, multipart buffering, database access or Groq.
`createApp` is the internal injectable business router used by existing unit tests;
do not use it as a public server entry point.

## Runtime and build

Use Node **22.x**, selecting the latest supported security patch on each host.
The repository engines, `.node-version`, and `.nvmrc` select major 22. Vercel's
project Node setting must also be 22.x; Render's `NODE_VERSION` must select 22.

From the repository root:

For an isolated clean installation/build/test run without `.env` files, old
generated clients or build output, run `npm run verify:clean`. Logs are retained
under the ignored `.verification/` directory. This requires package downloads
and build subprocesses, but does not connect to PostgreSQL or Groq.

```sh
npm ci --include=dev
npm run build -w api
NEXT_PUBLIC_API_BASE_URL=https://YOUR-API.onrender.com npm run build -w web
npm run typecheck -w api
npm run typecheck -w web
npm run lint -w web
npm test -w api
npm test -w web
```

On PowerShell, set `$env:NEXT_PUBLIC_API_BASE_URL='https://YOUR-API.onrender.com'`
before the frontend build instead of using the shell assignment above.

The API build runs offline Prisma generation with `prisma.generate.config.ts`
and then TypeScript. Generation does not load `.env`, require a connection URL,
connect to a database or apply migrations. Keep dev dependencies during builds.
Always rebuild `dist`; existing checked-in output is not the deployment source.
Existing uncommitted root build artifacts were preserved during this task; the
verified builds are in `.verification/`. Do not publicly start the stale root
`dist` without a fresh build from the reviewed source.
Next production builds fail if the public API URL is missing, HTTP, localhost,
contains credentials, or is not an origin. Never use a real secret in that URL.

## Server environment

All values below belong only to Render (or the private migration environment).
See `apps/api/.env.example` for names and placeholders. Do not overwrite the
existing local `.env` with these placeholders.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Production validation |
| `NODE_VERSION=22` | Render Node major |
| `HOST=0.0.0.0` | Public Render binding (also the code default) |
| `PORT` | Supplied by Render; default local value is 4000 |
| `CORS_ORIGINS` | Comma-separated exact HTTPS Vercel production origins; no trailing slashes, paths or wildcards |
| `DATABASE_URL` | Demo runtime PostgreSQL URL; direct or session-pooler connection |
| `DATABASE_CA_PATH` | Trusted CA file path; required in production, relative to API process working directory or absolute Linux path |
| `DIRECT_URL` | Demo migration connection; needed only for migration config, not runtime/generation |
| `GROQ_API_KEY` | Backend-only Groq key for both endpoints |
| `DEMO_USERS_JSON` | Exactly two IDs mapped to separately generated salted scrypt hashes |
| `DEMO_TOKEN_SECRET` | Random signing secret, at least 32 bytes; generate with a secure password manager |
| `DEMO_ACCESS_EXPIRES_AT` | Absolute future ISO timestamp, e.g. the planned end of the review, with timezone |
| `DEMO_TOKEN_TTL_SECONDS` | Default 900 seconds; maximum 3600 |
| `DEMO_TOKEN_VERSION` | Default `1`; change and restart/redeploy to revoke all issued tokens |

`apps/web` needs only `NEXT_PUBLIC_API_BASE_URL=https://YOUR-API.onrender.com`.
It is embedded at build time. Configure the Production environment before building.
Do not give Vercel database URLs, demo credentials, hashes, signing keys or Groq keys.

## Prepare credentials privately

Choose two different strong passwords (at least 16 characters). IDs such as
`presenter` and `reviewer` are labels only, not roles. Generate each hash with:

```sh
npm run demo:hash --silent -w api
```

The utility reads one password from stdin until EOF and prints only a salted hash.
Prefer piping password-manager output. Do not type plaintext into command arguments,
shell history or a screen-shared terminal. Interactive terminal input may echo.
For PowerShell, this masked-input pattern avoids plaintext in command history:

```powershell
$demoPassword = Read-Host 'Demo password' -AsSecureString
$demoPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($demoPassword)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($demoPointer) | npm run demo:hash --silent -w api
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($demoPointer)
  $demoPassword.Dispose()
}
```

Set `DEMO_USERS_JSON` to a JSON object containing the two IDs and the resulting
`salt:hash` strings. Store it as a private Render environment value, never in Git.
Send each person their own credentials separately from the demo link.

Tokens are HMAC-SHA256 signed, checked by Express on every business request,
and stored only in browser memory. Refresh, lock, expiry or a 401 shows the unlock
screen. Reviewed drafts/pending saves remain in tab-scoped sessionStorage, but
audio is memory-only and is lost when the gate unmounts the recording flow.

Changing `DEMO_TOKEN_VERSION` or rotating the signing secret and restarting revokes
all old tokens. Change passwords at the same time if credentials were shared.
The fixed deadline stops existing tokens and new logins. Removing access entirely
can also be done by stopping the Render service. Configuration changes require a
restart/redeploy. The UI Lock button clears this browser's token; it is not remote
token revocation. Existing in-flight operations may finish after expiry/revocation.

Login limits: 10 attempts/IP/10 minutes, 10 attempts/ID/10 minutes, 30 global/10
minutes, and two concurrent password checks. AI limits: 10 requests/ID/10 minutes,
30 global/10 minutes, one active request per ID and two globally. Transcription
and extraction share that budget. Limits are in-memory and reset on restart;
run **one Render instance**. They are demo safeguards, not a durable billing cap.
Render's final proxy hop is trusted for client IP; preserve this network topology.
Compressed JSON requests are rejected (415); the normal browser client sends
uncompressed JSON. Parser/upload packages include the compatible security fixes.

## Supabase demo project (manual; no remote commands were executed)

1. Create a new project and keep its data synthetic. Obtain its database URLs and
   CA from the authenticated dashboard. The checked-in CA is public, but verify it
   against the intended project's CA; replace/provide the appropriate public CA if needed.
2. Use the direct connection if IPv6 works from the host, otherwise the Supavisor
   **session pooler** for IPv4. Use a direct or migration-compatible session
   connection for `DIRECT_URL`, not transaction pooling.
3. Run migration commands from `apps/api` in a **private environment configured
   only for the new demo project**. Confirm the project identity before any write.
   Set `DATABASE_CA_PATH` to the local trusted CA file; do not reuse a Windows
   absolute `sslrootcert` path on Render.
4. Inspect history first, then apply the reviewed migrations only to the new demo:

```sh
# From apps/api; these commands target whatever DIRECT_URL you configure.
npx prisma migrate status --config prisma7.config.ts
npx prisma migrate deploy --config prisma7.config.ts
```

Both initial and catalogue migrations are required. `migrate status` can return
nonzero when migrations are pending. Do not use `migrate reset`, `db push`, or
`migrate dev` against hosted data. Never paste CLI connection output into chat.
Review Supabase Data API exposure/RLS for these tables; this application uses
server-side PostgreSQL and does not need anonymous browser database access.

Runtime and migration helpers resolve `DATABASE_CA_PATH` on the current OS,
override obsolete URL CA paths, and require certificate/hostname verification.
The Prisma migration config translates pg's `verify-full` parameters to the
Prisma native-engine equivalents; it does not disable verification. No
`NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized:false` is needed.

## Render backend (manual)

1. Create a Web Service from the reviewed repository/branch. Include the current
   untracked catalogue/auth source and migration when you later commit it yourself.
2. Leave Root Directory at the **repository root**, so the root lockfile and
   workspaces are available.
3. Set Build Command to `npm ci --include=dev && npm run build -w api`.
4. Set Start Command to `npm run start -w api` and Health Check Path to `/health`.
5. Configure the private environment above. Since the workspace start script runs
   in `apps/api`, `DATABASE_CA_PATH=certs/prod-ca-2021.crt` resolves there. Alternatively
   mount the intended public CA as a Render secret file and set its absolute path.
6. Set the exact Vercel production origin(s) in `CORS_ORIGINS`. Preflight accepts
   `Authorization`, `Content-Type`, and `Idempotency-Key`. Cookies are not used.
7. Deploy only after review. `/health` is public and checks the process, not DB/Groq.

## Vercel frontend (manual)

1. Import the same repository/branch; choose Next.js and Root Directory `apps/web`.
2. Use Node 22.x, root-lockfile-aware installation (`npm ci --include=dev` from the
   repository root) and `npm run build` in `apps/web`; retain the Next.js preset output.
   If overriding Install Command from the app root, use `cd ../.. && npm ci --include=dev`.
3. Set Production `NEXT_PUBLIC_API_BASE_URL` to the final Render HTTPS origin.
4. Keep previews disabled/unshared for this demo, or explicitly add only approved
   preview origins to backend CORS. Avoid wildcard preview allowlists.
5. Deploy only after review; rebuild whenever the public API URL changes.

## Release checks

- Direct unauthenticated calls to all business routes must return 401, including
  `/transcriptions` and `/sales/extract`, even without Origin or with malformed bodies.
- Both logins must work; incorrect passwords, tampered/expired/revoked tokens must
  fail; throttling should return 429. Never print a real token in diagnostic output.
- Test actual microphone permission, capture, preview and upload on the presenter
  and reviewer's intended browsers at the final HTTPS URL.
- Check live Groq transcription and extraction from Render. Prior local DNS issues
  mean mocked provider tests are not proof of this connectivity.
- Record a clearly labelled synthetic sale, review catalogue matching/aliases,
  confirm once, check Home/History, and retry the same pending save safely.
- Test expiry/refresh and draft restoration; do not discard pending-save state to
  work around uncertain writes. Product/alias creation persists before sale saving.
- Inspect frontend bundles for private configuration or credential material.
- A paid Render instance avoids free-service idle sleeps. If using free capacity,
  account for cold starts and test reviewer access after inactivity.
- Revoke/expire access after review. Full authentication and shop isolation remain
  future work; this demo must never contain multiple shops' real records.
