// A small in-memory stand-in for the database, for tests that follow a whole path (one deployment:
// an ask refused, what's saved, the alert's row) without Postgres. It keeps rows per table, applies
// no conditions except the audit log's actions (each action named in a query is matched), and
// honours limit and newest-first on the audit log. Enough to catch a write that shouldn't happen.

import { auditLog, type Db } from "@launchpad/db";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const ACTION = /^[a-z-]+\.[a-z.-]+$/;

export interface FakeDb {
  db: Db;
  rows: (table: unknown) => Row[];
  writes: { kind: "insert" | "update" | "delete"; table: string; values?: unknown }[];
}

export function fakeDb(seed: [unknown, Row[]][] = []): FakeDb {
  const store = new Map<string, Row[]>();
  const writes: FakeDb["writes"] = [];
  const name = (t: unknown) => getTableName(t as never);
  const rows = (t: unknown) => {
    const n = name(t);
    if (!store.has(n)) store.set(n, []);
    return store.get(n) as Row[];
  };
  for (const [t, r] of seed) rows(t).push(...r);
  let nextId = 1;

  const propOf = (column: { table: unknown }) => {
    const cols = getTableColumns(column.table as never) as Record<string, unknown>;
    return Object.keys(cols).find((k) => cols[k] === column);
  };
  const pick = (selection: Record<string, unknown> | undefined, row: Row, from: unknown): Row => {
    if (!selection) return row;
    const out: Row = {};
    for (const [key, val] of Object.entries(selection)) {
      if (isTable(val)) out[key] = name(val) === name(from) ? row : rows(val)[0];
      else if (val && typeof val === "object" && "table" in val) {
        const prop = propOf(val as { table: unknown });
        const source = name((val as { table: unknown }).table) === name(from) ? row : rows((val as { table: unknown }).table)[0];
        out[key] = prop && source ? source[prop] : undefined;
      } else out[key] = undefined;
    }
    return out;
  };

  const query = (run: (state: { where?: unknown; limit?: number; returning?: boolean }) => unknown[]) => {
    const state: { where?: unknown; limit?: number; returning?: boolean } = {};
    const chain: Record<string, unknown> = {};
    const self = new Proxy(chain, {
      get(_t, key) {
        if (key === "then") {
          return (ok: (v: unknown[]) => unknown, no: (e: unknown) => unknown) => {
            try {
              return Promise.resolve(run(state)).then(ok, no);
            } catch (err) {
              return Promise.reject(err).then(ok, no);
            }
          };
        }
        if (key === "catch") return (no: (e: unknown) => unknown) => (self as unknown as Promise<unknown>).then((v) => v, no);
        return (arg: unknown) => {
          if (key === "where") state.where = arg;
          if (key === "limit") state.limit = arg as number;
          if (key === "returning") state.returning = true;
          return self;
        };
      },
    });
    return self;
  };

  const select = (selection?: Record<string, unknown>) => ({
    from: (table: unknown) =>
      query((state) => {
        let list = [...rows(table)];
        if (name(table) === name(auditLog)) {
          const params = state.where ? dialect.sqlToQuery(state.where as never).params : [];
          const actions = params.filter((p): p is string => typeof p === "string" && ACTION.test(p));
          if (actions.length) list = list.filter((r) => actions.includes(r.action as string));
          list.sort((a, b) => (b.at as Date).getTime() - (a.at as Date).getTime() || (b.id as number) - (a.id as number));
        }
        if (state.limit !== undefined) list = list.slice(0, state.limit);
        return list.map((r) => pick(selection, r, table));
      }),
  });
  const db = {
    select,
    selectDistinct: select,
    insert: (table: unknown) => ({
      values: (values: Row | Row[]) =>
        query((state) => {
          const added: Row[] = [];
          for (const v of Array.isArray(values) ? values : [values]) {
            // alerts_sent's key is unique.
            if (name(table) === "alerts_sent" && rows(table).some((r) => r.key === v.key)) continue;
            const row = { id: nextId++, at: new Date(), ...v };
            rows(table).push(row);
            added.push(row);
            writes.push({ kind: "insert", table: name(table), values: v });
          }
          return state.returning ? added : [];
        }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) =>
        query(() => {
          for (const r of rows(table)) Object.assign(r, values);
          writes.push({ kind: "update", table: name(table), values });
          return [];
        }),
    }),
    delete: (table: unknown) =>
      query(() => {
        writes.push({ kind: "delete", table: name(table) });
        return [];
      }),
  };
  return { db: db as unknown as Db, rows, writes };
}

// Replaces the console's database (lib/db.ts) for the test.
export function useFakeDb(fake: FakeDb) {
  (globalThis as unknown as { launchpadDb?: Db }).launchpadDb = fake.db;
}
