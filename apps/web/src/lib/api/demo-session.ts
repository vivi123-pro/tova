// Access tokens live only in this module's memory, never browser storage.
type Session = { token: string; expiresAt: number };
let session: Session | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
export function getDemoSession() { return session; }
export function subscribeDemoSession(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function clearDemoSession(expectedToken?: string) {
  // A late response from an earlier session must not log out a newer login.
  if (expectedToken && session?.token !== expectedToken) return;
  clearTimeout(timer); session = null; listeners.forEach(listener => listener());
}
export function setDemoSession(value: Session) {
  if (!value.token || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 3_600_000) throw new Error("Invalid demo session.");
  clearTimeout(timer); session = value;
  timer = setTimeout(() => clearDemoSession(value.token), Math.max(0, value.expiresAt - Date.now()));
  listeners.forEach(listener => listener());
}
export function demoToken() {
  if (session && session.expiresAt <= Date.now()) clearDemoSession(session.token);
  return session?.token;
}
