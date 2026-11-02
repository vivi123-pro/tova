import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";

// Log only fixed categories, never error messages, URLs, hostnames or certificates.
export function databaseFailure(error: unknown) {
  const top = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof top.code === "string" && /^P\d{4}$/.test(top.code) ? top.code : "unknown";
  const parts: string[] = [];
  const seen = new Set<object>();
  function inspect(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "message", "reason"]) {
      if (typeof record[key] === "string") parts.push((record[key] as string).slice(0, 8192));
    }
    for (const key of ["cause", "meta", "driverAdapterError"]) inspect(record[key], depth + 1);
  }
  inspect(error);
  const details = parts.join("\n");
  let tlsCategory: string | undefined;
  if (/ERR_TLS_CERT_ALTNAME_(INVALID|FORMAT)|HOSTNAME_MISMATCH|hostname\/ip does not match|does not match certificate.s altnames/i.test(details)) tlsCategory = "hostname_mismatch";
  else if (/CERT_HAS_EXPIRED|certificate has expired/i.test(details)) tlsCategory = "certificate_expired";
  else if (/CERT_NOT_YET_VALID|certificate is not yet valid/i.test(details)) tlsCategory = "certificate_not_yet_valid";
  else if (/SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|self[- ]signed certificate|unable to (?:verify (?:the )?first certificate|get (?:local )?issuer certificate)/i.test(details)) tlsCategory = "certificate_chain_untrusted";
  else if (code === "P1011") tlsCategory = "tls_cause_unavailable";
  return { code, ...(tlsCategory ? { tlsCategory } : {}) };
}

export function databaseConfiguration(config: PoolConfig, production: boolean) {
  const url = new URL(config.connectionString!);
  const host = url.searchParams.getAll("host").at(-1) || url.hostname;
  const port = url.searchParams.getAll("port").at(-1) || url.port || "5432";
  const ssl = config.ssl && typeof config.ssl === "object" ? config.ssl as ConnectionOptions : undefined;
  const endpoint = host.endsWith(".pooler.supabase.com")
    ? port === "6543" ? "supabase_transaction_pooler" : port === "5432" ? "supabase_session_pooler" : "supabase_pooler_other_port"
    : host.endsWith(".supabase.co") ? "supabase_direct" : "other";
  return {
    event: "database_configuration", driver: "prisma-pg", production,
    nodeVersion: process.versions.node, endpoint,
    tls: ssl?.rejectUnauthorized === true ? "verified" : "driver_default",
    caSource: ssl?.ca ? "custom_ca" : "node_defaults",
    clientCertificateWithoutKey: Boolean(ssl?.cert && !ssl.key),
  };
}
