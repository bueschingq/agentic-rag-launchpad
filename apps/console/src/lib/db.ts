import { createDb, type Db } from "@launchpad/db";
import { env } from "./env.ts";

// One pool per server process, surviving dev hot reloads.
const store = globalThis as unknown as { launchpadDb?: Db };

export function db(): Db {
  store.launchpadDb ??= createDb(env().databaseUrl).db;
  return store.launchpadDb;
}
