import Link from "next/link";
import type { ReactNode } from "react";
import { Navigation } from "./navigation";
import { SalesSession } from "@/features/sales/components/sales-session";
import { DemoGate } from "./demo-gate";

export function AppShell({ children }: { children: ReactNode }) {
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="brand-header"><Link href="/" className="brand" aria-label="Tova home">tova<span>.</span></Link><span className="tagline">Speak it. Track it.</span><span className="brand-note">A little more ease, every day.</span></header>
    <DemoGate><SalesSession><main id="main-content" className="page-content" tabIndex={-1}>{children}</main><Navigation /></SalesSession></DemoGate>
  </>;
}
