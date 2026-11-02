import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Client } from "pg";
import { databasePoolConfig, databaseUrl, prismaDatabaseUrl } from "../src/database-config.js";

const raw = "postgresql://demo:unused@db.example:5432/demo?application_name=tova";
const production = { NODE_ENV: "production" };
const custom = { ...production, DATABASE_CA_PATH: "certs/prod-ca-2021.crt" };
function driverSsl(config: ReturnType<typeof databasePoolConfig>) {
  // Constructing a Client parses config but opens no sockets or database sessions.
  const client = new Client(config);
  const ssl = client.ssl as ConnectionOptions;
  assert.ok(ssl && typeof ssl === "object");
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity, undefined);
  assert.equal(ssl.servername, undefined);
  return ssl;
}

test("production uses default Node trust without requiring a custom CA", () => {
  const config = databasePoolConfig(raw, production);
  const ssl = driverSsl(config);
  assert.equal(ssl.ca, undefined);
  assert.equal(new URL(config.connectionString!).searchParams.get("application_name"), "tova");
  assert.equal(new URL(databaseUrl(raw, production)).searchParams.get("sslmode"), "verify-full");
});

test("weak and conflicting URL modes cannot disable production verification", () => {
  for (const mode of ["disable", "prefer", "require", "verify-ca", "no-verify", "verify-full"]) {
    const config = databasePoolConfig(`${raw}&sslmode=${mode}&sslmode=disable&ssl=no-verify&uselibpqcompat=true&sslaccept=accept_invalid_certs`, production);
    driverSsl(config);
    const url = new URL(config.connectionString!);
    for (const parameter of ["ssl", "sslmode", "sslaccept", "uselibpqcompat"]) assert.equal(url.searchParams.has(parameter), false);
  }
});

test("explicit verification survives insecure PGSSLMODE environment defaults", () => {
  const previous = process.env.PGSSLMODE;
  try { process.env.PGSSLMODE = "no-verify"; driverSsl(databasePoolConfig(raw, production)); }
  finally { if (previous === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = previous; }
});

test("custom CA remains optional and replaces obsolete URL paths with a portable verified CA", () => {
  const config = databasePoolConfig(`${raw}&sslmode=disable&sslrootcert=C%3A%2Fmissing.crt`, custom);
  const ssl = driverSsl(config);
  assert.equal(ssl.ca, readFileSync(custom.DATABASE_CA_PATH, "utf8"));
  assert.equal(new URL(config.connectionString!).searchParams.has("sslrootcert"), false);
  assert.throws(() => databasePoolConfig(raw, { ...production, DATABASE_CA_PATH: "missing-ca.crt" }), /DATABASE_CA_PATH/);
  // Explicit URL CA paths are honored rather than silently discarded.
  const viaUrl = databasePoolConfig(`${raw}&sslrootcert=certs%2Fprod-ca-2021.crt`, production);
  assert.equal(driverSsl(viaUrl).ca, ssl.ca);
  assert.throws(() => databasePoolConfig(`${raw}&sslrootcert=missing-ca.crt`, production), /TLS certificate/);
});

test("default hostname checker rejects a mismatched certificate identity", () => {
  const ssl = driverSsl(databasePoolConfig(raw, production));
  const verify = ssl.checkServerIdentity ?? checkServerIdentity;
  const certificate = { subject: { CN: "other.example" }, subjectaltname: "DNS:other.example" };
  assert.ok(verify("db.example", certificate));
  assert.equal(verify("other.example", certificate), undefined);
});

test("production rejects Unix sockets that would bypass pg TLS", () => {
  for (const url of ["postgresql:///demo", `${raw}&host=%2Fvar%2Frun%2Fpostgresql`, `${raw}&host=db.example&host=%2Fvar%2Frun%2Fpostgresql`, "postgresql://%2Fvar%2Frun%2Fpostgresql/demo"]) assert.throws(() => databasePoolConfig(url, production), /TCP hostname/);
});

test("Prisma CLI uses native strict TLS with and without a custom CA", () => {
  const url = new URL(prismaDatabaseUrl(`${raw}&sslmode=disable&sslaccept=accept_invalid_certs`, production));
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(url.searchParams.get("sslaccept"), "strict");
  assert.equal(url.searchParams.has("sslcert"), false);
  const withCa = new URL(prismaDatabaseUrl(raw, custom));
  assert.equal(withCa.searchParams.get("sslaccept"), "strict");
  assert.match(withCa.searchParams.get("sslcert")!, /certs\/prod-ca-2021.crt$/);
  assert.equal(withCa.searchParams.has("sslrootcert"), false);
});

test("development configuration remains unchanged unless verified TLS is selected", () => {
  assert.equal(databaseUrl(raw, {}), raw);
  assert.deepEqual(databasePoolConfig(raw, {}), { connectionString: raw });
  driverSsl(databasePoolConfig(`${raw}&sslmode=verify-full`, {}));
  assert.throws(() => databasePoolConfig(undefined, production), /valid PostgreSQL/);
});
