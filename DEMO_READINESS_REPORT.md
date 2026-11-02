# Tova restricted demo readiness — 1 November 2026

The requested local implementation is complete. No application was deployed,
no remote database connection/migration was attempted, no records were changed,
and nothing was committed or pushed. Existing uncommitted business/catalogue work
was retained. Permanent authentication and shop isolation were not implemented.

## Changes

- Added an outer Express demo gate on the executable server. Every business route
  requires a signed, expiring bearer token before request-body parsing, uploads,
  database delegates or paid AI operations can run.
- Two separately hashed credentials, salted scrypt verification, constant-time
  comparisons, login throttling, shared AI quotas/concurrency limits, hard access
  deadline and token-version/signing-secret rotation provide temporary access control.
- Added a frontend unlock form and memory-only token handling. Expiry/401 returns
  to unlock; late responses cannot clear a newer session. Existing review and
  pending-save storage remains intact. Audio is released/lost on session lock.
- Added Render binding, explicit production CORS, authenticated preflight headers,
  safe errors, and rejection of compressed JSON requests.
- Next production configuration rejects absent/unsafe public API origins.
- API builds explicitly generate Prisma Client offline before compilation.
- PostgreSQL runtime/migration configuration resolves a host-local CA path and
  enables certificate/hostname verification, overriding obsolete Windows URL paths.
- Standardized on Node 22.x and added a reproducible isolated clean-check command.

## Files created or modified by this task

Existing dirty files beyond this list belong to earlier work; their changes are
not claimed as part of this implementation. Existing tracked `apps/api/dist`
changes were left intact; clean builds were run in an isolated directory instead.

| Area | Files |
| --- | --- |
| Root | `.gitignore`, `.node-version` (new), `.nvmrc` (new), `package.json`, `package-lock.json` |
| Documentation | `DEPLOYMENT.md` (new), this report (new), `apps/api/README.md`, `apps/api/certs/README.md`, `apps/web/README.md` |
| Clean verification | `scripts/verify-clean.mjs` (new) |
| API configuration/build | `apps/api/.env.example` (new), `apps/api/package.json`, `apps/api/prisma.generate.config.ts` (new), `apps/api/prisma7.config.ts` |
| API security/connectivity | `apps/api/src/demo-access.ts` (new), `demo-app.ts` (new), `database-config.ts` (new), `app.ts`, `db.ts`, `index.ts` |
| Credential utility | `apps/api/scripts/hash-demo-password.mjs` (new) |
| API tests | `apps/api/test/demo-access.test.ts` (new) |
| Frontend configuration | `apps/web/.env.example`, `apps/web/next.config.ts`, `apps/web/package.json` |
| Frontend UI | `apps/web/src/components/layout/demo-gate.tsx` (new), `app-shell.tsx`, `apps/web/src/app/globals.css` |
| Frontend requests/session | `apps/web/src/lib/api/demo-session.ts` (new), `client.ts` |
| Frontend tests | `apps/web/test/demo-session.test.mjs` (new), `integration.test.mjs` |

## Dependencies

| Change | Versions |
| --- | --- |
| Next.js and matching ESLint config | 16.4.0 → 16.4.1 |
| Multer upload security fix | 2.4.0 → 2.5.0 |
| Express transitive security fixes in lockfile | body-parser 2.3.0 → 2.4.0; qs 6.16.0 → 6.17.1 |
| Explicit API development/build dependencies | @types/cors 2.8.19, @types/express 5.0.6, TypeScript 5.9.3, tsx 4.23.15 |

React/React DOM remain 19.3.0, Express remains 5.3.0, and Prisma remains 7.10.0.
No authentication dependency or database migration was introduced.

## Verification results

`npm run verify:clean` copied the current source into an ignored directory,
excluding `.env`, existing dependencies, generated Prisma source and build output.
No database URLs were supplied; private canary variables were used for bundle checks.
The final clean run used local Node 22.16.0 and npm 10.9.2 on Windows.

| Check | Result |
| --- | --- |
| `npm ci --include=dev` in clean copy | PASS |
| API production build, including offline Prisma generation | PASS |
| Next.js production build | PASS |
| Production build with missing API URL | Correctly rejected |
| API and frontend TypeScript checks | PASS |
| Frontend ESLint | PASS |
| API automated tests | 44 passed, 0 failed |
| Frontend automated tests | 29 passed, 0 failed |
| Browser static assets, private build canaries | Absent |
| Browser static assets, configured backend secret values/passwords | No matches in 16 assets; values were not printed |
| Compiled Next server HTTP smoke | `/`, `/record`, `/review`, `/history` each returned 200 with unlock form |
| Compiled API entrypoint smoke | Public health, protected routes, login, authenticated validation and expiry all passed using a nonexistent DB hostname and ephemeral credentials |

The test coverage includes invalid credentials, tampered tokens, expiry, version
revocation, production preflight headers, unauthorized requests before parsing/AI,
AI rate/concurrency limits, login throttling, compressed-body rejection, and the
existing financial/idempotency/catalogue/recording flows with fake services.

Final clean logs: `.verification/clean-1793533250205/`. Local smoke and secret-scan
utilities/output are also in `.verification/`, which is ignored by Git.

## Remaining risks and manual work

- `npm audit --omit=dev` still reports **5 findings: 4 high, 1 moderate**, through
  Prisma's optional CLI/development dependency graph (`prisma`, `@prisma/config`,
  `deepmerge-ts`, `mysql2`, `fast-uri`). The application does not import the CLI
  into request handlers or use MySQL. These are not claimed fixed; assess and patch
  that tooling before broader production use. A broad Prisma upgrade was avoided.
- Limits are process-local; use one Render instance. Restarts reset quotas. They
  are not a durable provider billing limit. Set provider-side budget controls too.
- Both credentials see and can change the same demo shop. Use only synthetic data.
- Root tracked build artifacts remain from earlier work. **Do not run the old
  `dist` as a public service.** Use source development or a fresh build/clean checkout;
  the documented Render build regenerates the protected entry point.
- A local Windows build does not prove Render Linux network/TLS behavior. Verify
  the correct Supabase CA, host connectivity, intended migration history, actual
  domains/CORS and Vercel settings after deployment is separately authorized.
- Real microphone/browser interaction, hosted HTTPS, live Groq DNS/key/model/quota
  checks, and a complete demo-database save remain manual integration checks.
  No remote migrations or real provider calls were made by this task.
- Audio cannot survive lock/expiry/refresh; the unlock screen explains this.
  Revocation stops subsequent requests; already-running operations may finish.

Required variables, private credential-generation instructions, exact Vercel/
Render/Supabase steps, and a release checklist are in [DEPLOYMENT.md](DEPLOYMENT.md).
You must create/select the separate demo project, verify its CA, configure both
credentials/signing secret/deadline and host variables, then review/commit the
intended source yourself. Migration and deployment actions remain manual and
require your later authorization; this task did not perform them.

Security references: [Next.js October update](https://nextjs.org/blog/nextjs-security-update-october-14-2026),
[body-parser advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828),
[Multer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m).
