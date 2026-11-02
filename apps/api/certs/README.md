# Supabase development CA

For the protected demo, see [DEPLOYMENT.md](../../../DEPLOYMENT.md).
`DATABASE_CA_PATH` is optional, including in production. Without it or a URL CA
path, the runtime uses Node's default trusted roots while requiring certificate
and hostname verification. Set it only when the database requires a custom CA.
The helper resolves relative paths on the current OS, overrides obsolete URL CA
paths when a custom CA is supplied, and enforces `verify-full` in production.
Offline client generation uses `prisma.generate.config.ts` and needs no database
URL or certificate. The local URL instructions below remain valid for development.

`prod-ca-2021.crt` was copied from the locally downloaded Supabase dashboard
certificate. It is a public CA certificate, not a database credential.

For a new checkout, obtain the CA from the intended project's authenticated
Supabase Dashboard: Database Settings → SSL Configuration → Download Certificate.
Verify its provenance before trusting it. Do not use a private key here.

For file-free deployment use URLs without certificate file paths. If using a
custom CA, prefer `DATABASE_CA_PATH` over manually encoding `sslrootcert` in both
URLs. Old local URL certificate paths must not be copied onto Render; an explicit
missing file is an error, not a request to use default roots.

The installed Prisma 7.10 native schema engine does not implement pg's
`sslmode=verify-full`/`sslrootcert` pair. `prisma7.config.ts` translates that pair
only for the CLI into `sslmode=require`, optional `sslcert=<same CA path>`, and
`sslaccept=strict`. Without a custom CA the native CLI uses its default trust
store, which is separate from Node's. The pg adapter receives explicit verified
TLS options; URL TLS parameters are consumed so they cannot override them.

Run CLI commands from the API workspace, for example:

```powershell
npm exec -w api -- prisma validate
npm exec -w api -- prisma migrate status
```

`migrate status` inspects migration history; it does not apply migrations.
Never commit `.env` or paste connection strings into diagnostic output.
