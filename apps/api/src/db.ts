import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { databasePoolConfig } from "./database-config.js";

// Verified TLS uses Node's default CA roots unless a custom CA is configured.
export const db = new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(process.env.DATABASE_URL)) });
