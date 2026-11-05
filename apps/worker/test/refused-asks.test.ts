// A refused ask isn't an answer (fix cycle 7d). Each path that asks Agentic RAG, with the ask failing
// as it failed in the block of 2 Nov (402 fixture), a 503 and a timeout: nothing changes, and the
// block is recorded, through to the alert's row. No network and no database: fetch is a stub that
// refuses anything but its fixtures, and the database is test/support/fake-db.ts.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import {
  alertsSent,
  auditLog,
  contentPages,
  credentialContext,
  credentials,
  deployments,
  sealSecret,
  settings,
  syncSources,
  tenants,
} from "@launchpad/db";
import { accountBlock, BLOCKED, UNBLOCKED } from "../../console/src/lib/account-block.ts";
import { blockNotice, plainFailure, refusalOf, refusalText } from "../../console/src/lib/ask-refusal.ts";
import {
  askAgain,
  askStarter,
  askStartersBatch,
  prepareQuestions,
  prepareStarters,
  probeAccount,
  reaskAfterSync,
  recheckUnderLatestRules,
  revalidate,
  runValidation,
  saveStarters,
  starterRemoval,
} from "../../console/src/lib/validation.ts";
import { type FakeDb, fakeDb, useFakeDb } from "../../console/test/support/fake-db.ts";
import { sendAlerts } from "../src/jobs/alerts.ts";
import { failedInBlock, sendProblem } from "../src/jobs/content.ts";
import { bringUpToDate, recheckAccount } from "../src/jobs/rules-rollout.ts";

const refused402 = JSON.parse(readFileSync(new URL("../../console/test/fixtures/ask-refused-402.json", import.meta.url), "utf8")) as {
  status: number;
  body: { detail: string };
};

const master = randomBytes(32);
const base64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
process.env.DATABASE_URL = "postgres://not-used.invalid/none";
process.env.LAUNCHPAD_MASTER_KEY = master.toString("base64");
process.env.PAR_NUA_KEY = `${base64url({ alg: "none" })}.${base64url({ iss: "https://aws-us-east-2-1.dp.progress.cloud/", allow_kb_management: true })}.x`;

const ID = "11111111-1111-4111-8111-111111111111";
const STARTER = "How much does it cost?";
const answered = (question: string) => ({
  question,
  answer: "It costs $10 per month.",
  sources: [{ title: "Pricing", url: "https://example.com/pricing" }],
  answered: true,
  verdict: "answered",
});
const lastRun = () => ({
  at: "2026-11-02T17:00:00.000Z",
  passed: true,
  seconds: 1,
  questions: [
    { ...answered(STARTER), starter: true, acknowledged: { by: "u", name: "Dana", at: "2026-11-02T17:01:00.000Z", verified: true } },
    answered("What do you offer?"),
  ],
});

type Reply = { status: number; body: unknown } | "timeout" | "offline";
let reply: (body: { query?: string }, n: number) => Reply;
let asks = 0;
let webhook: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://hooks.invalid/")) {
      webhook.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    assert.ok(url.includes(".invalid") || url.includes("progress.cloud"), `unexpected fetch: ${url}`);
    if (url.endsWith("/ask")) {
      asks += 1;
      const got = reply(JSON.parse(String(init?.body ?? "{}")), asks);
      if (got === "timeout") throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      if (got === "offline") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(got.body), { status: got.status, headers: { "content-type": "application/json" } });
    }
    // Everything else (the judge, saved filters): refused too, as in a block.
    return new Response(JSON.stringify({ detail: "not in this test" }), { status: 404 });
  }) as typeof fetch;
}

const good = (answer = "It costs $10 per month.") => ({
  status: 200,
  body: { answer, status: "success", citations: {}, retrieval_results: { resources: {} } },
});
const noContext = { status: 200, body: { answer: "Not enough data to answer this.", status: "no_context" } };
const server = { status: 503, body: { detail: "unavailable" } };

let fake: FakeDb;
const dep = () => fake.rows(deployments)[0] as Record<string, unknown> & { validation: unknown; widgetSettings: { starters?: string[] } };
const audits = (action: string) => fake.rows(auditLog).filter((r) => r.action === action);

function seed(over: Record<string, unknown> = {}) {
  fake = fakeDb([
    [tenants, [{ id: "t1", name: "Acme", displayName: null }]],
    [
      deployments,
      [
        {
          id: ID,
          tenantId: "t1",
          name: "Main site",
          zone: "aws-us-east-2-1",
          kbId: "22222222-2222-4222-8222-222222222222",
          status: "live",
          published: true,
          language: "en",
          siteUrl: "https://example.com",
          domains: ["example.com"],
          systemPrompt: "Answer from the site.",
          searchConfig: "launchpad",
          answeringRules: 6,
          signOff: { by: "u", name: "Dana", at: "2026-11-01T10:00:00.000Z", verified: true },
          widgetSettings: { starters: [STARTER] },
          validation: lastRun(),
          confirmations: {},
          preflight: null,
          priceTable: null,
          priceTableConfirmation: null,
          ...over,
        },
      ],
    ],
    [
      credentials,
      [{ deploymentId: ID, role: "reader", secret: sealSecret("reader-token", master, credentialContext(ID, "reader")), revokedAt: null }],
    ],
    [settings, [{ id: 1, alertWebhookUrl: "https://hooks.invalid/alerts", alertEmails: [] }]],
    [contentPages, []],
    [syncSources, [{ id: "s1", deploymentId: ID, kind: "sitemap", lastSyncedAt: new Date("2026-11-02T18:00:00Z"), startedAt: null }]],
  ]);
  useFakeDb(fake);
}

const nothingChanged = (before: string, starters: readonly string[] = [STARTER]) => {
  assert.equal(JSON.stringify(dep().validation), before, "the run is as it was");
  assert.deepEqual(dep().widgetSettings.starters, starters, "the starters are as they were");
  assert.equal(audits("deployment.starters.removed").length, 0);
  assert.equal(audits("deployment.validate").length, 0);
};
const noRawWords = (text: string) => {
  for (const raw of ["POST", "/ask", "/api/", "00000000-1111", "AccountBlockingState", "progress.cloud"])
    assert.ok(!text.includes(raw), `"${raw}" on screen in: ${text}`);
};

const FAILURES: [string, () => Reply][] = [
  ["402, as in the block", () => refused402],
  ["503", () => server],
  ["a timeout", () => "timeout"],
  ["no connection", () => "offline"],
  ["a 200 whose status says error", () => ({ status: 200, body: { answer: "", status: "error" } })],
];

beforeEach(() => {
  asks = 0;
  webhook = [];
  reply = () => good();
  stubFetch();
  seed();
  console.error = () => {};
});

describe("a refused ask changes nothing, on every path", () => {
  for (const [what, failing] of FAILURES) {
    it(`validation run: ${what}`, async () => {
      reply = failing;
      const before = JSON.stringify(dep().validation);
      const result = await runValidation(ID, null);
      assert.ok("error" in result && result.refused, "it says it was refused");
      noRawWords(result.error);
      nothingChanged(before);
      // The run stopped: not every question was asked, however many there are.
      assert.ok(asks <= 4, `${asks} asks`);
    });
  }

  it("the worker's re-run after a sync that changed pages (what removed 11 starters)", async () => {
    reply = () => refused402;
    const before = JSON.stringify(dep().validation);
    await assert.rejects(reaskAfterSync(ID), /stopped answering/);
    nothingChanged(before);
  });

  it("the worker's automatic run after the first sync, on a new onboarding", async () => {
    // The onboarding's state: a partial run, the sync since finished.
    const run = { ...lastRun(), at: new Date(Date.now() - 3_600_000).toISOString(), content: { partial: true, answerable: 3, total: 6 } };
    seed({ published: false, signOff: null, validation: run });
    reply = () => refused402;
    const before = JSON.stringify(dep().validation);
    await revalidate();
    nothingChanged(before);
    assert.equal(audits(BLOCKED).length, 1);
  });

  it("a question waiting on added pages stays waiting", async () => {
    const run = lastRun();
    run.questions[1] = { ...run.questions[1]!, added: { at: "2026-11-02T17:30:00.000Z", urls: ["https://example.com/a"] } } as never;
    seed({ validation: run });
    reply = () => server;
    const before = JSON.stringify(dep().validation);
    const result = await askAgain(ID, 1, "What do you offer?", { auto: "pages-added" });
    assert.ok("refused" in result);
    nothingChanged(before);
  });

  it("the picker: one row, and the batch", async () => {
    reply = () => refused402;
    const one = await askStarter(ID, "Can I try it free?");
    assert.ok("error" in one);
    noRawWords(one.error);
    assert.match(one.error, /because of its budget/);
    const many = await askStartersBatch(ID, ["Can I try it free?", "Where are you?"]);
    assert.ok("error" in many);
  });

  it("the picker's save doesn't save starters it couldn't ask", async () => {
    reply = () => refused402;
    const who = { by: "u", name: "Dana", at: "2026-11-02T18:00:00.000Z", verified: true };
    const result = await saveStarters(ID, ["A new question?"], who);
    assert.ok("error" in result);
    noRawWords(result.error);
    assert.deepEqual(dep().widgetSettings.starters, [STARTER]);
  });

  it("suggestions: a refusal says so, instead of 'no suggestions'", async () => {
    reply = () => refused402;
    const starters = await prepareStarters(ID, { fresh: true });
    assert.ok("error" in starters && /budget/.test(starters.error));
    const questions = await prepareQuestions(ID);
    assert.ok("error" in questions && /budget/.test(questions.error));
    assert.equal(audits("deployment.starters.suggested").length, 0);
  });

  it("the rollout's re-check: neither applied nor held, tried later", async () => {
    for (const failing of [() => refused402, () => server as Reply]) {
      reply = failing;
      const recheck = await recheckUnderLatestRules(ID);
      assert.ok("error" in recheck && recheck.retry);
      noRawWords(recheck.error);
    }
  });

  it("the rollout reads the block from the re-check, and starts nothing while it stands", async () => {
    assert.deepEqual(recheckAccount({ error: "x", retry: true, refused: { kind: "block", state: "BUDGET" } }), { blocked: "BUDGET" });
    reply = () => refused402;
    await runValidation(ID, null);
    const ctx = { db: fake.db, masterKey: master, log: () => {} };
    const said = await bringUpToDate(ctx, { night: true });
    assert.deepEqual(said, ["waiting: the account is blocked"]);
    assert.equal(fake.writes.filter((w) => w.table === "deployments").length, 0);
  });
});

describe("removing a live starter needs an answer that says no answer", () => {
  it("a re-ask refused partway: the starter stays", async () => {
    // The first pass gets a real no-answer, and the ask once more is refused.
    let n = 0;
    reply = () => {
      n += 1;
      return n <= 2 ? noContext : refused402;
    };
    await assert.rejects(reaskAfterSync(ID));
    assert.deepEqual(dep().widgetSettings.starters, [STARTER]);
    assert.equal(audits("deployment.starters.removed").length, 0);
  });

  it("an empty reply: the starter stays", async () => {
    reply = () => ({ status: 200, body: { answer: "", status: "success" } });
    await reaskAfterSync(ID);
    assert.deepEqual(dep().widgetSettings.starters, [STARTER]);
    assert.equal(audits("deployment.starters.removed").length, 0);
  });

  it("Agentic RAG saying it has no answer, twice: it goes", async () => {
    reply = () => noContext;
    await reaskAfterSync(ID);
    assert.deepEqual(dep().widgetSettings.starters, []);
    assert.equal(audits("deployment.starters.removed").length, 1);
  });

  it("starterRemoval, row by row", () => {
    const q = (o: object) => ({ question: "Q?", answer: "", sources: [], answered: false, ...o }) as never;
    assert.equal(starterRemoval(q({ answered: true, answer: "Yes." }), { answer: "Yes.", status: "success" }), "answered");
    assert.equal(starterRemoval(q({ verdict: "no-context" }), { answer: "", status: "no_context" }), "remove");
    assert.equal(starterRemoval(q({ verdict: "empty" }), { answer: "", status: "error" }), "keep");
    assert.equal(starterRemoval(q({ verdict: "empty" }), { answer: "", status: "success" }), "keep");
    assert.equal(starterRemoval(q({ verdict: "substituted" }), { answer: "Call us.", status: "success" }), "keep");
    assert.equal(starterRemoval(q({ answered: true, failure: "x" }), { answer: "Yes.", status: "success" }), "keep");
  });
});

describe("the block is named, once, through to the alert's row", () => {
  // The alerts job's other looks find nothing to say.
  const ctx = () => {
    fake.rows(syncSources).length = 0;
    fake.rows(credentials).length = 0;
    return { db: fake.db, masterKey: master, log: () => {} };
  };
  const sent = () => fake.rows(alertsSent).map((r) => String(r.key));

  it("the first refusal records it, and one alert goes, however many asks are refused", async () => {
    reply = () => refused402;
    await runValidation(ID, null);
    await runValidation(ID, null);
    assert.equal(audits(BLOCKED).length, 1);
    assert.equal((await accountBlock(fake.db))?.state, "BUDGET");
    await sendAlerts(ctx(), new Date(), {});
    await sendAlerts(ctx(), new Date(), {});
    const keys = sent().filter((k) => k.startsWith("account-"));
    assert.equal(keys.length, 1);
    assert.match(keys[0]!, /^account-blocked:/);
    assert.equal(webhook.filter((w) => w.includes("blocked for budget")).length, 1);
    for (const w of webhook) noRawWords(w);
  });

  it("the re-run job records it too (the path that recorded nothing), and its alert row", async () => {
    const run = { ...lastRun(), questions: [{ ...lastRun().questions[0]!, failure: "No answer to a starter question", answered: false }] };
    seed({ validation: run });
    reply = () => refused402;
    await assert.rejects(reaskAfterSync(ID));
    assert.equal(audits(BLOCKED).length, 1);
    await sendAlerts(ctx(), new Date(), {});
    assert.ok(sent().some((k) => k.startsWith("account-blocked:")));
  });

  it("while it stands, one ask a minute, and the first good answer clears it, with one alert", async () => {
    reply = () => refused402;
    await runValidation(ID, null);
    asks = 0;
    await revalidate();
    assert.equal(asks, 1, "only the check");
    assert.equal(audits(UNBLOCKED).length, 0);
    reply = () => good();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await probeAccount(), true);
    assert.equal(audits(UNBLOCKED).length, 1);
    await sendAlerts(ctx(), new Date(), {});
    await sendAlerts(ctx(), new Date(), {});
    assert.equal(sent().filter((k) => k.startsWith("account-unblocked:")).length, 1);
  });

  it("an answer on its way when the block began doesn't clear it", async () => {
    // The batch's asks come back either side of the first refusal.
    let n = 0;
    reply = () => {
      n += 1;
      return n === 1 ? refused402 : good();
    };
    await runValidation(ID, null);
    assert.equal(audits(BLOCKED).length, 1);
    assert.equal(audits(UNBLOCKED).length, 0);
  });
});

describe("what a person reads", () => {
  it("says what's happening, what wasn't done and who can fix it", () => {
    const text = blockNotice("BUDGET");
    assert.match(text, /stopped answering for this account because of its budget/);
    assert.match(text, /Answers weren't checked and nothing was changed/);
    assert.match(text, /Whoever holds the Agentic RAG account/);
    noRawWords(text);
  });

  it("a stored refusal from before the fix reads plainly", () => {
    const stored = `Agentic RAG didn't answer: POST aws-us-east-2-1.dp.progress.cloud/api/v1/kb/c4829ebd/ask → 402: ${refused402.body.detail}; No answer to a starter question`;
    const text = plainFailure(stored);
    noRawWords(text);
    assert.match(text, /because of its budget/);
    assert.match(text, /No answer to a starter question/);
    assert.equal(plainFailure("Answered in German"), "Answered in German");
  });

  it("each kind of failure has its own words, none raw", () => {
    for (const err of [
      new Error("POST h/api/v1/kb/x/ask → 503: down"),
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      new TypeError("fetch failed"),
    ])
      noRawWords(refusalText(refusalOf(err)));
    noRawWords(sendProblem(new Error("POST h/api/v1/kb/x/resources → 500: down")));
  });
});

describe("pages that failed during a block", () => {
  const window = { from: new Date("2026-11-02T18:00:00Z"), to: new Date("2026-11-02T19:00:00Z") };
  it("go back in the queue when it clears", () => {
    const at = new Date("2026-11-02T18:30:00Z");
    assert.equal(
      failedInBlock({ detail: "Couldn't send it to the Knowledge Box: POST h/x → 402: Access denied", updatedAt: at }, undefined),
      true,
    );
    assert.equal(failedInBlock({ detail: "Agentic RAG couldn't process the page's text.", updatedAt: at }, window), true);
  });
  it("others don't", () => {
    const later = new Date("2026-11-02T20:00:00Z");
    assert.equal(failedInBlock({ detail: "Agentic RAG couldn't process the page's text.", updatedAt: later }, window), false);
    assert.equal(
      failedInBlock({ detail: "Couldn't send it to the Knowledge Box: Agentic RAG reported a server error.", updatedAt: later }, window),
      false,
    );
    assert.equal(failedInBlock({ detail: "The site answered 404.", updatedAt: later }, window), false);
  });
});

describe("catching up after a block or a restart", () => {
  const SECOND = "33333333-3333-4333-8333-333333333333";
  const THIRD = "44444444-4444-4444-8444-444444444444";
  // Copies of the seeded deployment, each with its own reader credential. The fake database writes to
  // every row, so each minute below puts back what's still due on the deployments not yet asked.
  function more(...ids: string[]) {
    const [d] = fake.rows(deployments);
    for (const id of ids) {
      fake.rows(deployments).push({ ...d, id });
      fake.rows(credentials).push({
        deploymentId: id,
        role: "reader",
        secret: sealSecret("reader-token", master, credentialContext(id, "reader")),
        revokedAt: null,
      });
      fake
        .rows(syncSources)
        .push({ id: `s-${id}`, deploymentId: id, kind: "sitemap", lastSyncedAt: new Date("2026-11-02T18:00:00Z"), startedAt: null });
    }
  }
  const minutes = async (due: () => unknown, ids: readonly string[]) => {
    const asked: string[] = [];
    for (let left = ids.length; left > 0; left--) {
      for (const row of fake.rows(deployments)) row.validation = due();
      const before = audits("deployment.validate").length;
      const first = fake.rows(deployments)[0]!.id as string;
      const lines = await revalidate();
      assert.equal(audits("deployment.validate").length - before, 1, `one deployment this minute: ${lines.join("; ")}`);
      assert.ok(
        lines.some((l) => l.includes(first)),
        `the first still due goes first: ${lines.join("; ")}`,
      );
      assert.ok(!lines.some((l) => ids.some((id) => id !== first && l.includes(id))), "and no other");
      asked.push(first);
      fake.rows(deployments).shift();
      fake.rows(credentials).shift();
    }
    assert.deepEqual(asked, ids, "each in turn, none skipped");
  };

  it("after a sync: onboardings due at once go one a minute", async () => {
    seed({ published: false, signOff: null });
    more(SECOND, THIRD);
    await minutes(
      () => ({ ...lastRun(), at: new Date(Date.now() - 3_600_000).toISOString(), content: { partial: true, answerable: 3, total: 6 } }),
      [ID, SECOND, THIRD],
    );
  });

  it("after a restart: unfinished runs a refused ask left go one a minute", async () => {
    seed({ published: false, signOff: null });
    more(SECOND, THIRD);
    await minutes(
      () => ({
        ...lastRun(),
        questions: [
          { ...answered(STARTER), answered: false, verdict: "empty", failure: "Failed: Agentic RAG didn't answer (402)", starter: true },
        ],
      }),
      [ID, SECOND, THIRD],
    );
  });

  it("after a block clears: signed-off deployments whose pages changed go one a minute", async () => {
    seed();
    more(SECOND, THIRD);
    fake.rows(deployments).forEach((d) => {
      d.signOff = { by: "u", name: "Dana", at: "2026-11-01T10:00:00.000Z", verified: true };
    });
    await minutes(
      () => ({
        ...lastRun(),
        questions: [
          { ...answered(STARTER), answered: false, verdict: "empty", failure: "Failed: Agentic RAG didn't answer (402)", starter: true },
        ],
      }),
      [ID, SECOND, THIRD],
    );
  });
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});
