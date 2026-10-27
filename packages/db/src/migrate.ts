// Applies migrations/ to DATABASE_URL. Runs at container start (docker compose `migrate`),
// using only runtime dependencies so production images don't need drizzle-kit.

import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");

const { db, close } = createDb(url, { max: 1 });
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  console.log("Migrations applied.");
} finally {
  await close();
}
