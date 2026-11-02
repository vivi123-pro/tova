import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".verification", `clean-${Date.now()}`);
mkdirSync(target, { recursive: true });
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of new Set(files)) {
  const parts = file.split("/");
  if (parts.some(p => ["node_modules", ".next", "dist", ".verification"].includes(p)) ||
      parts.some(p => p.startsWith(".env") && p !== ".env.example") ||
      file.startsWith("apps/api/src/generated/") || file.endsWith(".tsbuildinfo")) continue;
  const dest = join(target, file); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(root, file), dest);
}
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(DEMO_|DATABASE_|DIRECT_URL$|GROQ_)/.test(name)) delete env[name];
delete env.NODE_ENV;
env.NEXT_PUBLIC_API_BASE_URL = "https://tova-demo-api.invalid";
env.NEXT_TELEMETRY_DISABLED = "1";
env.GROQ_API_KEY = "TOVA_BUILD_CANARY_PRIVATE_GROQ_7af435";
env.DEMO_TOKEN_SECRET = "TOVA_BUILD_CANARY_PRIVATE_SIGNING_8ef659";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run verify:clean.");
const results = [];
function step(name, args) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd: target, env, encoding: "utf8", timeout: 300_000, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(target, `${name}.log`), (result.stdout ?? "") + (result.stderr ?? ""));
  const ok = result.status === 0;
  results.push({ name, ok, exitCode: result.status });
  writeFileSync(join(target, "checks.json"), JSON.stringify(results, null, 2));
  console.log(`${name}: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) { console.log(((result.stdout ?? "") + (result.stderr ?? "")).slice(-6000)); throw new Error(`Clean check failed: ${name}. Logs: ${target}`); }
}
console.log(`Clean verification directory: ${target}`);
step("install", ["ci", "--include=dev", "--no-audit", "--no-fund", "--fetch-retries=1", "--fetch-timeout=120000"]);
step("api-build", ["run", "build", "-w", "api"]);
step("web-build", ["run", "build", "-w", "web"]);
const missingUrlEnv = { ...env }; delete missingUrlEnv.NEXT_PUBLIC_API_BASE_URL;
const rejected = spawnSync(process.execPath, [npm, "run", "build", "-w", "web"], { cwd: target, env: missingUrlEnv, encoding: "utf8", timeout: 60_000 });
const rejectedOutput = (rejected.stdout ?? "") + (rejected.stderr ?? "");
writeFileSync(join(target, "web-missing-api.log"), rejectedOutput);
if (rejected.status === 0 || !rejectedOutput.includes("Set NEXT_PUBLIC_API_BASE_URL")) throw new Error("Missing production API URL did not fail safely.");
console.log("web-rejects-missing-api: PASS");
step("api-types", ["run", "typecheck", "-w", "api"]);
step("web-types", ["run", "typecheck", "-w", "web"]);
step("web-lint", ["run", "lint", "-w", "web"]);
step("api-tests", ["test", "-w", "api"]);
step("web-tests", ["test", "-w", "web"]);
function* walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) yield* walk(path); else yield path; } }
for (const path of walk(join(target, "apps/web/.next/static"))) {
  const data = readFileSync(path);
  for (const name of ["GROQ_API_KEY", "DEMO_TOKEN_SECRET"]) if (data.includes(Buffer.from(env[name]))) throw new Error("A private build canary appeared in browser assets.");
}
console.log("browser-private-canaries: PASS (no credentials copied into clean checkout)");
console.log(`All clean checks passed. Logs retained at ${target}`);
