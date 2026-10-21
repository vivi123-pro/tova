# Supabase development CA

`prod-ca-2021.crt` was copied from the locally downloaded Supabase dashboard
certificate. It is a public CA certificate, not a database credential.

For a new checkout, obtain the CA from the intended project's authenticated
Supabase Dashboard: Database Settings → SSL Configuration → Download Certificate.
Verify its provenance before trusting it. Do not use a private key here.

Both URLs in the ignored `apps/api/.env` use `sslmode=verify-full` and
`sslrootcert` pointing to this certificate. Use a URL-encoded absolute path with
forward slashes, computed for the current checkout. This avoids different
certificate path resolution between pg and Prisma CLI. Update that local path
when moving the checkout; do not copy another developer's absolute path.

The installed Prisma 7.10 native schema engine does not implement pg's
`sslmode=verify-full`/`sslrootcert` pair. `prisma7.config.ts` translates that pair
only for the CLI into `sslmode=require`, `sslcert=<same CA path>`, and
`sslaccept=strict`. This requires TLS and preserves certificate and hostname
verification. The pg adapter receives the original URL parameters unchanged.

Run CLI commands from the API workspace, for example:

```powershell
npm exec -w api -- prisma validate
npm exec -w api -- prisma migrate status
```

`migrate status` inspects migration history; it does not apply migrations.
Never commit `.env` or paste connection strings into diagnostic output.
