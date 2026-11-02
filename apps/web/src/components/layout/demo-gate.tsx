"use client";

import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { apiBaseUrl } from "@/lib/api/client";
import { clearDemoSession, getDemoSession, setDemoSession, subscribeDemoSession } from "@/lib/api/demo-session";

export function DemoGate({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeDemoSession, getDemoSession, () => null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const username = String(fields.get("username") ?? "");
    const password = String(fields.get("password") ?? "");
    // Clear the password field as soon as it has been submitted.
    form.reset(); setBusy(true); setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/demo/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }), cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Wait before trying again." : response.status === 401 ? "Credentials are invalid or demo access has ended." : "Unable to unlock the demo. Try again.");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !("expiresAt" in value) || typeof value.expiresAt !== "number") throw new Error("Invalid unlock response.");
      setDemoSession({ token: value.token, expiresAt: value.expiresAt });
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to reach the demo."); }
    finally { setBusy(false); }
  }
  if (!session) return <main id="main-content" className="page-content" tabIndex={-1}>
    <section className="demo-unlock">
      <h1>Unlock the Tova demo</h1>
      <p>Use the temporary credentials shared by the presenter. This is one shared demo shop.</p>
      <p>Access expires automatically. Unlock again after a refresh or expired session. Reviewed drafts are retained in this tab; unsaved audio is lost when the session ends.</p>
      <form onSubmit={unlock}>
        <label>Demo username<input name="username" autoComplete="username" required maxLength={40} disabled={busy} /></label>
        <label>Demo password<input name="password" type="password" autoComplete="off" required maxLength={256} disabled={busy} /></label>
        <button type="submit" disabled={busy}>{busy ? "Unlocking…" : "Unlock demo"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  </main>;
  return <><div className="demo-access-bar"><span>Shared demo · session ends {new Date(session.expiresAt).toLocaleTimeString()}</span><button type="button" onClick={() => clearDemoSession()}>Lock demo</button></div>{children}</>;
}
