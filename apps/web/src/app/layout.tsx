import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "tova. — Speak it. Track it.",
  description: "A little less admin. Record your wholesale sales in your own words with Tova.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
