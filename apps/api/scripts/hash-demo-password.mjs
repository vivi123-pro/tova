import { randomBytes, scryptSync } from "node:crypto";

// Read from stdin, not argv or environment. Never echo plaintext.
let password = "";
for await (const chunk of process.stdin) password += chunk;
password = password.replace(/\r?\n$/, "");
if (password.length < 16 || password.length > 256) {
  console.error("Supply one password of 16–256 characters on stdin."); process.exitCode = 1;
} else {
  const salt = randomBytes(16).toString("hex");
  console.log(`${salt}:${scryptSync(password, salt, 64).toString("hex")}`);
}
