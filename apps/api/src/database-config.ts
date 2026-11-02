import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";

function certificateFile(path: string) {
  try { return readFileSync(path, "utf8"); }
  catch { throw new Error("Unable to read a configured PostgreSQL TLS certificate/key file."); }
}

export function databaseUrl(raw: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    if (!raw) throw new Error();
    url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch { throw new Error("A valid PostgreSQL connection URL is required."); }
  if (env.NODE_ENV === "production") {
    // Unix sockets bypass pg's TLS negotiation. Hosted production must use TCP.
    const host = decodeURIComponent(url.hostname);
    if (!host || [host, ...url.searchParams.getAll("host")].some(value => value.startsWith("/"))) throw new Error("Production PostgreSQL requires a TCP hostname.");
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.delete("sslaccept");
  }
  if (env.DATABASE_CA_PATH) {
    const caPath = resolve(env.DATABASE_CA_PATH);
    try { if (!readFileSync(caPath, "utf8").includes("-----BEGIN CERTIFICATE-----")) throw new Error(); }
    catch { throw new Error("DATABASE_CA_PATH must point to a readable trusted PostgreSQL CA certificate."); }
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.set("sslrootcert", caPath.replaceAll("\\", "/"));
    url.searchParams.delete("sslaccept");
  }
  return url.toString();
}

export function databasePoolConfig(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const url = new URL(databaseUrl(raw, env));
  if (url.searchParams.get("sslmode") !== "verify-full") return { connectionString: url.toString() };

  // pg URL SSL parameters replace the ssl object. Consume them here so strict
  // verification cannot be overwritten by URL options or PGSSLMODE defaults.
  const ssl: ConnectionOptions = { rejectUnauthorized: true };
  for (const [parameter, option] of [["sslrootcert", "ca"], ["sslcert", "cert"], ["sslkey", "key"]] as const) {
    const path = url.searchParams.get(parameter);
    if (path) ssl[option] = certificateFile(path);
  }
  for (const parameter of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslaccept", "uselibpqcompat"]) url.searchParams.delete(parameter);
  // Without `ca`, Node uses its default trusted roots. Do not replace the
  // default checkServerIdentity: pg supplies the destination host to Node TLS.
  return { connectionString: url.toString(), ssl };
}

export function prismaDatabaseUrl(raw: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(databaseUrl(raw, env));
  if (url.searchParams.get("sslmode") === "verify-full") {
    // Prisma CLI uses its native TLS stack, not pg/Node. Strict is required
    // even when no custom CA is supplied; otherwise its default is permissive.
    const rootCertificate = url.searchParams.get("sslrootcert");
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("sslaccept", "strict");
    if (rootCertificate) url.searchParams.set("sslcert", rootCertificate);
    url.searchParams.delete("sslrootcert");
  }
  return url.toString();
}
