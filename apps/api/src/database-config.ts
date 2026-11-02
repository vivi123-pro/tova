import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function databaseUrl(raw: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    if (!raw) throw new Error();
    url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch { throw new Error("A valid PostgreSQL connection URL is required."); }
  if (env.NODE_ENV === "production" && !env.DATABASE_CA_PATH) throw new Error("DATABASE_CA_PATH is required in production.");
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
