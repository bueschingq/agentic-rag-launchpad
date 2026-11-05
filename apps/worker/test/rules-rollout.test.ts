// The answering rules re-check (round 6, recheck 2): the account block it meets is recorded as the
// token route and the quality and usage jobs record it, and a hold is re-checked after a day.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { behindQuery, HOLD_RETRY_HOURS, inNight, nextStep, REREAD_LIMIT_MIN, recheckAccount, TARGET } from "../src/jobs/rules-rollout.ts";

describe("the rules re-check and the account block", () => {
  // As the overnight audit recorded it, from 19:00 to 00:50 UTC on 31 Oct.
  const refused =
    "Agentic RAG didn't answer: POST aws-us-east-2-1.dp.progress.cloud/api/v1/kb/67c6ca94-5e76-4c40-9b29-6fadc76f81ff/ask → 402: Access denied, as account c906143b-969a-45d7-839c-ecb753ec2d38 has an active 'AccountBlockingState.BUDGET' blockage on this features: upload,processing,search,generative,traini";

  it("reads the 402 budget refusal as the account blocked", () => {
    assert.deepEqual(recheckAccount({ error: refused, retry: true }), { blocked: "BUDGET" });
    assert.deepEqual(
      recheckAccount({ error: "Agentic RAG didn't answer: POST host/api/v1/kb/x/ask → 402: Payment required", retry: true }),
      {
        blocked: "BUDGET",
      },
    );
  });

  it("doesn't read other refusals or a missing key as a block", () => {
    assert.equal(recheckAccount({ error: "Agentic RAG didn't answer: POST host/ask → 503: unavailable", retry: true }), undefined);
    assert.equal(recheckAccount({ error: "Agentic RAG didn't answer: no answer within 30 s", retry: true }), undefined);
    assert.equal(recheckAccount({ error: "This deployment has no manager key." }), undefined);
  });

  it("reads a finished re-check, held or not, as the account answering (the all-clear)", () => {
    assert.deepEqual(recheckAccount({ total: 21, unchanged: 21, better: 0, worse: [] }), { answering: true });
    assert.deepEqual(
      recheckAccount({ total: 21, unchanged: 20, better: 0, worse: [{ question: "Q?", before: "A", after: "", was: "No answer" }] }),
      {
        answering: true,
      },
    );
  });

  it("records the block and the all-clear through lib/account-block.ts", () => {
    const source = readFileSync(new URL("../src/jobs/rules-rollout.ts", import.meta.url), "utf8");
    assert.match(source, /recordAccountBlock\(ctx\.db, state, WHERE\)/);
    assert.match(source, /recordAccountClear\(ctx\.db, WHERE\)/);
  });
});

describe("a held deployment", () => {
  it("is re-checked after 24 hours, and a repeat hold is marked so the alert stays once per version", () => {
    assert.equal(HOLD_RETRY_HOURS, 24);
    const source = readFileSync(new URL("../src/jobs/rules-rollout.ts", import.meta.url), "utf8");
    assert.match(source, /'deployment\.rules\.held' and \$\{auditLog\.at\} > now\(\) - make_interval\(hours => \$\{HOLD_RETRY_HOURS\}\)/);
    assert.match(source, /\.\.\.\(earlier && \{ repeat: true \}\)/);
  });
});

describe("bring up to date overnight (round 6, item 5)", () => {
  const now = new Date("2026-11-02T02:00:00Z");
  const minutes = (n: number) => new Date(now.getTime() - n * 60_000);

  it("reads a deployment's outdated pages again first, then waits for the re-read", () => {
    assert.deepEqual(nextStep({ outdated: 229, rulesBehind: false, reading: [], synced: true, now }), { kind: "reread" });
    assert.deepEqual(nextStep({ outdated: 0, rulesBehind: false, started: minutes(5), reading: ["a", "b"], synced: true, now }), {
      kind: "wait",
      reading: 2,
    });
  });

  it("re-checks once the re-read is done, or lists the unfinished pages after 30 minutes and stops waiting", () => {
    assert.deepEqual(nextStep({ outdated: 0, rulesBehind: false, started: minutes(12), reading: [], synced: true, now }), {
      kind: "recheck",
      unfinished: [],
    });
    assert.equal(REREAD_LIMIT_MIN, 30);
    assert.deepEqual(nextStep({ outdated: 3, rulesBehind: false, started: minutes(31), reading: ["/a", "/b", "/c"], synced: true, now }), {
      kind: "recheck",
      unfinished: ["/a", "/b", "/c"],
    });
  });

  it("re-checks straight away when only the answering rules are behind, and leaves a deployment that settled today", () => {
    assert.deepEqual(nextStep({ outdated: 0, rulesBehind: true, reading: [], synced: true, now }), { kind: "recheck", unfinished: [] });
    assert.deepEqual(nextStep({ outdated: 0, rulesBehind: false, reading: [], synced: true, now }), { kind: "none" });
    assert.deepEqual(nextStep({ outdated: 2, rulesBehind: false, settled: minutes(90), reading: [], synced: true, now }), { kind: "none" });
  });

  it("runs between 00:00 and 06:00 in the server's time zone, or the one given", () => {
    assert.equal(inNight(new Date("2026-11-02T02:00:00Z"), "UTC"), true);
    assert.equal(inNight(new Date("2026-11-02T06:00:00Z"), "UTC"), false);
    assert.equal(inNight(new Date("2026-11-02T23:30:00Z"), "UTC"), false);
    assert.equal(inNight(new Date("2026-11-02T23:30:00Z"), "Europe/Berlin"), true);
  });

  it("names its target versions, and calls track B's re-check rather than copying it", () => {
    assert.match(TARGET, /^\d+\.\d+\.\d+$/);
    const source = readFileSync(new URL("../src/jobs/rules-rollout.ts", import.meta.url), "utf8");
    assert.match(source, /await recheckUnderLatestRules\(d\.id\)/);
    assert.match(source, /const PER_RUN = 2;/);
  });
});

// Round 7: `started` was written with a bare "id" that resolved to audit_log's own id, so it was
// always null and every re-check ran a minute after queuing.
describe("the job waits for its re-read: the SQL behind() generates", () => {
  const url = process.env.DATABASE_URL;
  // Connects only in the database test.
  const client = postgres(url ?? "postgres://nobody@127.0.0.1:1/none", { max: 1, connect_timeout: 5 });
  const query = behindQuery(drizzle({ client }) as never, { night: true }).toSQL();

  it("names the deployments table in both subqueries", () => {
    assert.equal(query.sql.match(/a\.target_id = "deployments"\."id"::text/g)?.length, 2);
    assert.doesNotMatch(query.sql, /target_id = "id"::text/);
  });

  // Runs the query as generated, read-only: a WITH stands in for its tables, so nothing real is read
  // or written. It needs a Postgres server with the schema: DATABASE_URL (npm test skips it without).
  it("reads when the re-read started, on a real Postgres", { skip: !url }, async () => {
    const at = "2026-11-02 10:33:35.862169+00";
    const id = "c7e70ef1-d34f-4af3-a178-11d37ada5198";
    const audit = (n: number, target: string, step: string, when: string) =>
      `select ${n}::bigint as id, null::uuid as actor_user_id, 'deployment.uptodate'::text as action, 'deployment'::text as target_type, '${target}'::text as target_id, '{"target":"${TARGET}","step":"${step}","to":0}'::jsonb as detail, '${when}'::timestamptz as at`;
    const columns = await client<{ table_name: string; column_name: string; udt_name: string }[]>`
      select table_name, column_name, udt_name from information_schema.columns
      where table_schema = 'public' and table_name in ('deployments', 'content_pages')`;
    const given: Record<string, string> = {
      id: `'${id}'::uuid`,
      kb_id: "'kb'",
      system_prompt: "'prompt'",
      status: "'live'",
      answering_rules: "0",
    };
    const row = (table: string) =>
      columns
        .filter((c) => c.table_name === table)
        .map((c) => `${(table === "deployments" && given[c.column_name]) || `null::${c.udt_name}`} as ${c.column_name}`)
        .join(", ");
    // Drizzle's select has no column names: started and settled are its 5th and 6th columns.
    const run = async (entries: string[]) => {
      const rows = (await client
        .unsafe(
          `with "deployments" as (select ${row("deployments")}),
          "content_pages" as (select ${row("content_pages")} where false),
          "audit_log" as (${entries.join(" union all ")})
          ${query.sql}`,
          query.params as never[],
        )
        .values()) as unknown as (string | null)[][];
      return rows.map((r) => ({ started: r[4]!, settled: r[5]! }));
    };
    const reread = audit(1, id, "reread", at);
    try {
      const [waiting] = await run([reread]);
      assert.equal(Date.parse(waiting!.started!), Date.parse(at), "the re-read's start is read");
      assert.equal(waiting!.settled, null);
      assert.deepEqual(
        nextStep({
          outdated: 0,
          rulesBehind: true,
          started: new Date(waiting!.started!),
          reading: ["https://x/a"],
          synced: true,
          now: new Date(Date.parse(at) + 60_000),
        }),
        { kind: "wait", reading: 1 },
      );
      const [applied] = await run([reread, audit(2, id, "applied", "2026-11-02 11:00:00+00")]);
      assert.equal(applied!.started, null, "a re-read that was applied is over");
      assert.ok(applied!.settled);
      const [other] = await run([audit(1, "another-deployment", "reread", at), audit(3, id, "unfinished", at)]);
      assert.equal(other!.started, null, "another deployment's re-read isn't this one's");
    } finally {
      await client.end();
    }
  });
});
