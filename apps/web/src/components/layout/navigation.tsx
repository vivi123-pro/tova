"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";

const destinations = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/record", label: "Record", icon: "mic" },
  { href: "/history", label: "History", icon: "history" },
] as const;
export function Navigation() {
  const pathname = usePathname();
  return <nav className="navigation" aria-label="Main navigation">{destinations.map(({ href, label, icon }) =>
    <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}><Icon name={icon} /><span>{label}</span></Link>
  )}</nav>;
}
