import type { NextConfig } from "next";
import path from "node:path";

if (process.env.NODE_ENV === "production") {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  try {
    if (!base) throw new Error();
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error();
  } catch { throw new Error("Set NEXT_PUBLIC_API_BASE_URL to the public HTTPS API origin before building production."); }
}

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
