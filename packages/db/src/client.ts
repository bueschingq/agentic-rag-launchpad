import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: opts.max ?? 10 });
  return { db: drizzle({ client, schema }), close: () => client.end() };
}
