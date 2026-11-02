import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { databasePoolConfig } from "./database-config.js";
import { databaseConfiguration } from "./database-diagnostics.js";

// Verified TLS uses Node's default CA roots unless a custom CA is configured.
const config = databasePoolConfig(process.env.DATABASE_URL);
console.info(JSON.stringify(databaseConfiguration(config, process.env.NODE_ENV === "production")));
export const db = new PrismaClient({ adapter: new PrismaPg(config) });
