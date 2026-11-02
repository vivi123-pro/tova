import { defineConfig } from "prisma/config";

// Client generation is offline and must not load .env or require a database URL.
export default defineConfig({ schema: "prisma/schema.prisma" });
