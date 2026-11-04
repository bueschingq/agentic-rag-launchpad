import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AuditEntry,
  budgetAlerts,
  CHECKS_VERSION,
  changeAlert,
  heldAlert,
  keyAlerts,
  notVerified,
  olderChecksAlerts,
  openItems,
  provisioningAlert,
  rulesAlert,
  SAME_FAILURE_MS,
  STARTER_REMOVED,
  starterRemovedAlert,
  syncWaitAlert,
  VISITOR_CHANGES,
  validationAlert,
  validationAlerts,
} from "../src/jobs/alerts.ts";
import { answeredFromLog, isPartnerTest, maskPersonalData, toAskedQuestion } from "../src/jobs/usage.ts";

describe("budgetAlerts", () => {
  const t = { id: "t1", name: "Harbor View Dental", budgetCents: 10_000, mode: "alert" };

  it("alerts once per threshold per month", () => {
    assert.deepEqual(budgetAlerts(t, 7_999, "2026-10"), []);
    assert.deepEqual(
      budgetAlerts(t, 8_000, "2026-10").map((a) => a.key),
      ["budget-80:t1:2026-10"],
    );
    assert.deepEqual(
      budgetAlerts({ ...t, mode: "stop" }, 12_000, "2026-10").map((a) => a.key),
      ["budget-80:t1:2026-10", "budget-100:t1:2026-10"],
    );
    assert.match(budgetAlerts({ ...t, mode: "stop" }, 12_000, "2026-10")[1]!.message.text, /offline/);
    // Crossing both at once sends only the higher one; the 80% one is recorded so it never follows.
    assert.deepEqual(
      budgetAlerts(t, 12_000, "2026-10").map((x) => [x.key, Boolean(x.silent)]),
      [
        ["budget-80:t1:2026-10", true],
        ["budget-100:t1:2026-10", false],
      ],
    );
    assert.equal(budgetAlerts(t, 8_500, "2026-10")[0]!.silent, undefined);
    assert.deepEqual(budgetAlerts({ ...t, budgetCents: null }, 50_000, "2026-10"), []);
  });
});

describe("provisioningAlert", () => {
  const d = { id: "d1", name: "Main site", tenantName: "Crayola (UX review r3)" };
  const failure = (detail: string, at: string) => ({ step: "kb", status: "failed" as const, at, detail });

  it("is one alert per cause, naming the customer and the reason in plain words", () => {
    const limit = "POST …/kbs → 402: You reached the maximum number of Knowledge Boxes for this account.";
    const retries = Array.from({ length: 9 }, (_, i) =>
      provisioningAlert({ ...d, provisioningLog: [failure(limit, `2026-10-30T07:${10 + i}:00Z`)] }, undefined),
    );
    assert.equal(new Set(retries.map((a) => a.key)).size, 1);
    assert.equal(retries[0]!.message.subject, "Crayola (UX review r3) › Main site: provisioning failed (Knowledge Box limit reached)");
    assert.match(retries[0]!.message.text, /no Knowledge Boxes left/);
    assert.doesNotMatch(retries[0]!.message.text, /402|POST/);
    const other = provisioningAlert({ ...d, provisioningLog: [failure("POST …/kbs → 403: Forbidden", "2026-10-30T08:00:00Z")] }, undefined);
    assert.notEqual(other.key, retries[0]!.key);
  });
});

describe("syncWaitAlert", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const row = { deploymentId: "d1", name: "Help", tenantName: "Harbor View Dental", indexed: 0, queued: 40 };
  it("waits 15 minutes, then alerts once per run with the pages still waiting", () => {
    assert.equal(syncWaitAlert({ ...row, waitingSince: new Date("2026-10-30T11:50:00Z") }, now, undefined), undefined);
    const a = syncWaitAlert({ ...row, waitingSince: new Date("2026-10-30T11:40:00Z") }, now, "https://c/x#content");
    assert.equal(a?.key, "sync-waiting:d1:2026-10-30T11:40:00.000Z");
    assert.equal(a?.message.subject, "Harbor View Dental › Help: first sync still waiting after 20 min");
    assert.match(a?.message.text ?? "", /40 pages are waiting/);
    assert.equal(a?.message.link, "https://c/x#content");
    const one = syncWaitAlert({ ...row, queued: 1, waitingSince: new Date("2026-10-30T11:40:00Z") }, now, undefined);
    assert.match(one?.message.text ?? "", /and 1 page is waiting to load/);
  });
  it("stays quiet once a page is answerable", () => {
    assert.equal(syncWaitAlert({ ...row, indexed: 1, waitingSince: new Date("2026-10-30T10:00:00Z") }, now, undefined), undefined);
  });
});

describe("keyAlerts", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  it("warns at 60 days, again at 30 and at 7, naming the customer", () => {
    const at = (days: number) => [
      {
        deploymentId: "d1",
        name: "Main site",
        tenantName: "Crayola (UX review r3)",
        expiresAt: new Date(now.getTime() + days * 86_400_000),
      },
    ];
    assert.deepEqual(keyAlerts(at(75), now), []);
    assert.match(keyAlerts(at(59), now)[0]!.key, /^keys-60:d1:/);
    assert.equal(keyAlerts(at(59), now)[0]!.message.subject, "Crayola (UX review r3) › Main site: keys expire in 59 days");
    assert.match(keyAlerts(at(29), now)[0]!.key, /^keys-30:d1:/);
    assert.match(keyAlerts(at(6), now)[0]!.key, /^keys-7:d1:/);
  });
});

describe("olderChecksAlerts", () => {
  const link = (t: string, d: string) => `https://c/customers/${t}/deployments/${d}/review/up-to-date`;
  it("is one alert per customer, linking each deployment's Bring up to date, and once per checks version", () => {
    const rows = [
      { tenantId: "t1", tenantName: "Crayola (UX review r3)", deploymentId: "d1", name: "Main site" },
      { tenantId: "t1", tenantName: "Crayola (UX review r3)", deploymentId: "d2", name: "Help center" },
      { tenantId: "t2", tenantName: "Sitefinity demo", deploymentId: "d3", name: "Main site" },
    ];
    const [crayola, demo, ...rest] = olderChecksAlerts(rows, 2, link);
    assert.equal(rest.length, 0);
    assert.equal(crayola?.key, "older-checks:t1:2");
    assert.equal(crayola?.message.subject, "Crayola (UX review r3): 2 deployments signed off under older checks");
    assert.deepEqual(crayola?.message.fields, {
      "Main site": "https://c/customers/t1/deployments/d1/review/up-to-date",
      "Help center": "https://c/customers/t1/deployments/d2/review/up-to-date",
    });
    assert.equal(crayola?.message.link, "https://c/customers/t1/deployments/d1/review/up-to-date");
    assert.equal(demo?.message.subject, "Sitefinity demo › Main site: signed off under older checks");
    assert.equal(demo?.message.link, "https://c/customers/t2/deployments/d3/review/up-to-date");
    assert.match(demo?.message.text ?? "", /keeps serving\. Bring up to date/);
  });

  it("goes by the console's own checks version", async () => {
    // A path in a variable: the worker's typecheck can't follow the console's sign-in types.
    const review = "../../console/src/lib/review.ts";
    const { CHECKS_VERSION: consoles } = (await import(review)) as { CHECKS_VERSION: number };
    assert.equal(CHECKS_VERSION, consoles);
  });
});

describe("changeAlert", () => {
  const c = { id: 41, tenantName: "Crayola (UX review r3)", name: "Main site", who: "Quinton" };
  it("names the person, the field and the customer, once per save", () => {
    const a = changeAlert({ ...c, action: "deployment.widget", detail: { changed: ["settings.welcome"] } }, "https://c/r");
    assert.equal(a?.key, "change:41");
    assert.equal(a?.message.subject, "Crayola (UX review r3) › Main site: Quinton changed the welcome message");
    assert.match(a?.message.text ?? "", /^Quinton changed the welcome message on Crayola \(UX review r3\) › Main site\./);
    assert.equal(a?.message.link, "https://c/r");
    assert.equal(
      changeAlert({ ...c, action: "deployment.widget", detail: { changed: ["settings.nickname", "theme.color.primary"] } }, undefined)
        ?.message.subject,
      "Crayola (UX review r3) › Main site: Quinton changed the chat name and the primary color",
    );
  });

  it("says who in setup mode can't be told, and stays quiet for saves that changed nothing", () => {
    assert.match(
      changeAlert({ ...c, who: null, action: "deployment.prompt", detail: { before: { prompt: "a" }, after: { prompt: "b" } } }, undefined)
        ?.message.subject ?? "",
      /: Someone in setup mode changed how it answers$/,
    );
    assert.equal(changeAlert({ ...c, action: "deployment.widget", detail: { changed: [] } }, undefined), undefined);
    assert.equal(changeAlert({ ...c, action: "deployment.starters", detail: { before: ["A?"], after: ["A?"] } }, undefined), undefined);
    assert.equal(changeAlert({ ...c, action: "deployment.validate", detail: {} }, undefined), undefined);
    assert.match(
      changeAlert({ ...c, action: "deployment.pause", detail: {} }, undefined)?.message.subject ?? "",
      /Quinton paused the chat$/,
    );
  });

  it("marks a typed name as not verified once (round 5: “(setup mode, not verified) (not verified)”)", () => {
    assert.equal(notVerified("Sam Sales-Engineer (setup mode, not verified)"), "Sam Sales-Engineer (setup mode, not verified)");
    assert.equal(notVerified(" Sam "), "Sam (not verified)");
    assert.equal(notVerified("Quinton (not verified)"), "Quinton (not verified)");
    const a = changeAlert(
      { ...c, who: notVerified("Sam Sales-Engineer (setup mode, not verified)"), action: "deployment.prompt", detail: {} },
      undefined,
    );
    assert.equal(
      a?.message.subject,
      "Crayola (UX review r3) › Main site: Sam Sales-Engineer (setup mode, not verified) changed how it answers",
    );
    assert.equal(a?.message.subject.match(/not verified/g)?.length, 1);
  });
});

describe("question log", () => {
  it("leaves partner tests out", () => {
    assert.ok(isPartnerTest({ client_type: "dashboard" }));
    assert.ok(!isPartnerTest({ client_type: "api" }));
  });

  it("counts an answer only when something was retrieved and answered", () => {
    assert.ok(answeredFromLog({ status: 0, resources_count: 4, answer: "We open at 8." }));
    assert.ok(!answeredFromLog({ status: 0, resources_count: 0, answer: "We open at 8." }));
    // no_context, as the log records it (seen 2026-10-30): status -2 and no answer text.
    assert.ok(!answeredFromLog({ status: -2, resources_count: 3, answer: "" }));
    assert.ok(!answeredFromLog({ status: -1, resources_count: 3, answer: "x" }));
  });

  it("masks contact details before storing a question", () => {
    assert.equal(
      maskPersonalData("Email me at pat.smith+chat@client.co.uk or call +1 (555) 010-2030"),
      "Email me at [email] or call [phone]",
    );
    assert.equal(maskPersonalData("Is suite 1200 open in 2026?"), "Is suite 1200 open in 2026?");
    const q = toAskedQuestion({
      rows: [
        {
          id: 7,
          date: "2026-10-30 10:00:00.0",
          question: "call 555 010 2030",
          status: 0,
          resources_count: 1,
          answer: "Sure",
          feedback_good: false,
        },
      ],
    });
    assert.equal(q?.question, "call [phone]");
    assert.equal(q?.feedback, "bad");
  });
});

describe("validationAlert", () => {
  const demo = { id: "d1", name: "Sitefinity site", tenantName: "Sitefinity Demo Co (review)" };
  const signedOffAt = new Date("2026-10-31T00:50:00Z");
  const at = (time: string) => new Date(`2026-10-31T${time}Z`);
  // A run's audit entry, as validation writes it: `auto` when the console started it, and what it
  // opened compared with the run before.
  const validate = (id: number, time: string, detail: Record<string, unknown>): AuditEntry => ({
    id,
    action: "deployment.validate",
    at: at(time),
    detail,
  });
  const noAnswer = (question: string) => ({ question, was: "No answer" });

  it("never posts a person's run, nor the worker re-asking one of its questions (the demo, round 5)", () => {
    // 01:14:42 the person runs validation after Bring up to date: three No answers.
    const manual = validate(301, "01:14:42", {
      passed: false,
      opened: [
        noAnswer("How much do your products cost?"),
        noAnswer("Where can I buy your products?"),
        noAnswer("How can I place an order?"),
      ],
    });
    // 01:19:32 the worker asks one of them again with the page the person added, and it answers.
    // The saved run now says auto: "pages-added", still dated 01:14:42, with two answers open.
    const askAgain: AuditEntry = {
      id: 302,
      action: "deployment.validation.ask-again",
      at: at("01:19:32"),
      detail: { question: "How can I place an order?", answered: true, auto: "pages-added" },
    };
    const questions = [
      { question: "How much do your products cost?", answer: "", sources: [], answered: false },
      { question: "Where can I buy your products?", answer: "", sources: [], answered: false },
      { question: "How can I place an order?", answer: "Request a quote…", sources: [], answered: true },
    ];
    assert.deepEqual(
      validationAlerts({ ...demo, signedOffAt, questions }, [manual, askAgain], undefined),
      [],
      "nothing posted at 01:19:39",
    );

    // Later the automatic run after a sync opens one more: only that one is posted, not the two
    // the person's run left open.
    const synced = validate(310, "01:40:00", {
      auto: "sync-finished",
      passed: false,
      opened: [noAnswer("How do I create forms in Sitefinity?")],
    });
    const alerts = validationAlerts({ ...demo, signedOffAt, questions }, [manual, askAgain, synced], "https://c/d1#validate");
    assert.equal(alerts.length, 1);
    assert.equal(
      alerts[0]?.message.subject,
      "Sitefinity Demo Co (review) › Sitefinity site: the automatic re-run opened 1 answer after sign-off",
    );
    assert.deepEqual(alerts[0]?.message.fields, { "Opened 1": "“How do I create forms in Sitefinity?”: no answer" });
    assert.match(alerts[0]?.key ?? "", /^validation-open:d1:[0-9a-f]{16}:310$/);
    assert.equal(alerts[0]?.message.link, "https://c/d1#validate");
  });

  it("posts a price check the automatic re-run reopened on a signed-off deployment, once an hour (Exec, round 4)", () => {
    const questions = [
      { question: "How much does DevCraft Complete cost?", answer: "$1,299", sources: [], answered: true, flags: ["price" as const] },
    ];
    const reopened = (id: number, time: string) =>
      validate(id, time, {
        auto: "sync-finished",
        passed: false,
        opened: [{ question: "How much does DevCraft Complete cost?", was: "A check", reopened: true }],
      });
    const exec = { id: "d2", name: "Main site", tenantName: "Telerik (exec review r4)", signedOffAt, questions };
    const a = validationAlert(exec, reopened(401, "01:30:00"), undefined);
    assert.equal(a?.message.subject, "Telerik (exec review r4) › Main site: the automatic re-run opened 1 answer after sign-off");
    assert.deepEqual(a?.message.fields, {
      "Opened 1": "“How much does DevCraft Complete cost?”: a price to check again: it was checked before",
    });
    const fingerprint = a?.key.split(":")[2];
    assert.deepEqual(a?.quietIf, [{ like: `validation-%:d2:${fingerprint}:%`, ms: SAME_FAILURE_MS }]);
    const later = validationAlert(exec, reopened(402, "01:45:00"), undefined);
    assert.equal(later?.key.split(":")[2], fingerprint, "the same failure: kept quiet within the hour");
    assert.notEqual(later?.key, a?.key);
  });

  it("before sign-off, posts only a failing automatic run's new failures and lost answers, not new checks", () => {
    const unsigned = { id: "d3", name: "Main site", tenantName: "WhatsUp Gold (marketer r3)" };
    const opened = [
      { question: "Does WhatsUp Gold monitor AWS and Azure?", was: "Failed: Answered in German, asked in English" },
      { question: "How much does it cost?", was: "A check" },
    ];
    const a = validationAlert(unsigned, validate(501, "13:29:22", { auto: "sync-finished", passed: false, opened }), undefined);
    assert.equal(
      a?.message.subject,
      "WhatsUp Gold (marketer r3) › Main site: validation failed after the automatic run (1 answer no longer passes)",
    );
    assert.deepEqual(a?.message.fields, {
      "Failed 1": "“Does WhatsUp Gold monitor AWS and Azure?”: failed: Answered in German, asked in English",
    });
    assert.equal(
      validationAlert(unsigned, validate(502, "13:30:00", { auto: "sync-finished", passed: true, opened }), undefined),
      undefined,
    );
    assert.equal(
      validationAlert(unsigned, validate(503, "13:31:00", { auto: "sync-finished", passed: false, opened: [opened[1]] }), undefined),
      undefined,
      "only a check waiting: normal onboarding",
    );
  });

  it("stays quiet about a run on partial content, a run that opened nothing, and a person's run", () => {
    const opened = [noAnswer("A?")];
    const d = { ...demo, signedOffAt };
    assert.equal(
      validationAlert(d, validate(601, "02:00:00", { auto: "half-answerable", content: { partial: true }, opened }), undefined),
      undefined,
    );
    assert.equal(validationAlert(d, validate(602, "02:01:00", { auto: "sync-finished", passed: false }), undefined), undefined);
    assert.equal(validationAlert(d, validate(603, "02:02:00", { passed: false, opened }), undefined), undefined, "no auto: a person's");
  });

  it("leaves out a starter the run took off the chat (it has its own alert)", () => {
    const run = validate(701, "03:00:00", {
      auto: "sync-finished",
      passed: false,
      opened: [
        { question: "How do I contact sales?", was: "Failed: No answer to a starter question" },
        { question: "How do I contact support?", was: "A check" },
      ],
    });
    const removal: AuditEntry = {
      id: 702,
      action: STARTER_REMOVED,
      at: at("03:00:20"),
      detail: { question: "How do I contact sales?", reason: "no answer" },
    };
    const d = { ...demo, signedOffAt };
    assert.deepEqual(
      validationAlerts(d, [run], undefined).flatMap((a) => Object.values(a.message.fields ?? {})),
      ["“How do I contact sales?”: failed: No answer to a starter question", "“How do I contact support?”: an answer to check"],
    );
    assert.deepEqual(
      validationAlerts(d, [run, removal], undefined).flatMap((a) => Object.values(a.message.fields ?? {})),
      ["“How do I contact support?”: an answer to check"],
    );
  });
});

describe("starterRemovedAlert", () => {
  it("is one post per removal, naming the client, the starter and what to do", () => {
    const a = starterRemovedAlert(
      { id: 812, detail: { question: "How do I contact sales?", reason: "no answer" }, tenantName: "Telerik", name: "Main site" },
      "https://c/customers/t/deployments/d#validate",
    );
    assert.equal(a?.key, "starter-removed:812");
    assert.equal(
      a?.message.subject,
      "Telerik › Main site: starter “How do I contact sales?” removed from the chat after the automatic re-run (no answer). Pick again in Starters.",
    );
    assert.equal(a?.message.link, "https://c/customers/t/deployments/d#validate");
    assert.equal(starterRemovedAlert({ id: 1, detail: {}, tenantName: "T", name: "D" }, undefined), undefined);
  });

  it("isn't one of the change posts: it has its own", () => {
    assert.ok(!VISITOR_CHANGES.includes(STARTER_REMOVED));
  });
});

describe("openItems", () => {
  it("is what a person still owes: failures, no answers without a decision, and unchecked flags", () => {
    const decided = { by: null, name: "Quinton", at: "2026-10-30T10:00:00Z", verified: false, reason: "No online shop" };
    const items = openItems([
      { question: "A?", answer: "", sources: [], answered: false },
      { question: "B?", answer: "", sources: [], answered: false, notCovered: decided } as never,
      { question: "C?", answer: "$5", sources: [], answered: true, flags: ["price"] },
      { question: "D?", answer: "$5", sources: [], answered: true, flags: ["price"], acknowledged: decided },
      { question: "E?", answer: "x", sources: [], answered: true, failure: "Talks about how it works internally" },
      { question: "What can you tell me about Pricing?", answer: "", sources: [], answered: false },
    ]);
    assert.deepEqual(items, [
      { question: "A?", what: "no answer" },
      { question: "C?", what: "a price to check" },
      { question: "E?", what: "failed: Talks about how it works internally" },
    ]);
  });
});

describe("heldAlert (round 7: a hold posted nothing)", () => {
  const c = { deploymentId: "d1", tenantName: "Kemp", name: "Main site" };
  const detail = { step: "held", target: "7.7.5", total: 13, worse: [{ question: "How much does Kemp cost?" }] };
  it("posts the hold, with what got worse and a link to Review", () => {
    const a = heldAlert({ ...c, detail }, "https://c/r");
    assert.equal(a?.key, "up-to-date-held:d1:7.7.5");
    assert.equal(a?.message.subject, "Kemp › Main site: held on the overnight update");
    assert.match(a?.message.text ?? "", /1 of 13 answers got worse\. How much does Kemp cost\?/);
    assert.equal(a?.message.link, "https://c/r");
  });
  it("posts once per target, whatever the daily re-check repeats, and says why when nothing could be re-checked", () => {
    assert.equal(heldAlert({ ...c, detail: { ...detail, repeat: true } }, undefined)?.key, heldAlert({ ...c, detail }, undefined)?.key);
    const none = heldAlert(
      { ...c, detail: { step: "held", target: "7.7.5", total: 0, worse: [], why: "No validation run to re-check." } },
      undefined,
    );
    assert.match(none?.message.text ?? "", /No validation run to re-check\./);
  });
  it("stays quiet on any other step", () => {
    assert.equal(heldAlert({ ...c, detail: { step: "applied", target: "7.7.5" } }, undefined), undefined);
  });
});

describe("rulesAlert (round 6, item 7)", () => {
  const c = { id: 7, tenantName: "Crayola", name: "Main site" };
  it("posts one line when the re-check applies newer answering rules to a signed-off chat", () => {
    const a = rulesAlert({ ...c, who: null, detail: { from: 4, to: 5, recheck: { total: 14, unchanged: 12, better: 2 } } }, "https://c/r");
    assert.equal(a?.key, "change:7");
    assert.equal(a?.message.subject, "Crayola › Main site: answering rules v4 → v5, applied after a re-check");
    assert.match(a?.message.text ?? "", /14 of 14 answers were unchanged or better/);
    assert.equal(a?.message.link, "https://c/r");
  });
  it("names the person who switched after a hold, and stays quiet when nothing changed", () => {
    assert.equal(
      rulesAlert({ ...c, who: "Dana", detail: { from: 4, to: 5 } }, undefined)?.message.subject,
      "Crayola › Main site: answering rules v4 → v5, switched by Dana",
    );
    assert.equal(rulesAlert({ ...c, who: "Dana", detail: { from: 5, to: 5 } }, undefined), undefined);
    assert.equal(rulesAlert({ ...c, who: "Dana", detail: {} }, undefined), undefined);
  });
});
