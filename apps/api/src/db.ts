import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { databaseUrl } from "./database-config.js";

const connectionString = databaseUrl(process.env.DATABASE_URL);
// Preserve sslmode=verify-full and sslrootcert for node-postgres.
export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
