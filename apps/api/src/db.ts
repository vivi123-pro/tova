import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
// Preserve sslmode=verify-full and sslrootcert for node-postgres.
export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
