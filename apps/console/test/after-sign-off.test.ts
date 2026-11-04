import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationResult } from "@launchpad/db";
import { afterSignOffAlerts, buildDashboard, openSinceSignOff, startersRemoved } from "../src/lib/metrics.ts";
import { clockFigures, heldAtOf, onboardingClock } from "../src/lib/onboarding.ts";
import { gapsRuleNote } from "../src/lib/report.ts";

const t = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00Z`);

describe("the onboarding clock's two figures", () => {
  it('says "Signed off 13 min after starting" and "Held after the first sync: 19 min", from the start', () => {
    assert.deepEqual(clockFigures(t("10:00"), t("10:13"), t("10:19")), [
      "Signed off 13 min after starting",
      "Held after the first sync: 19 min",
    ]);
    assert.deepEqual(clockFigures(t("10:00"), t("10:13"), null), [
      "Signed off 13 min after starting",
      "Held after the first sync: not yet",
    ]);
    assert.deepEqual(clockFigures(t("10:00"), null, null), [], "nothing to say before the first sign-off");
  });

  it("reads SignOff.heldAt, and ignores a missing or unreadable one", () => {
    assert.equal(heldAtOf({ heldAt: "2026-10-30T10:19:00Z" })?.toISOString(), "2026-10-30T10:19:00.000Z");
    assert.equal(heldAtOf({}), null);
    assert.equal(heldAtOf({ heldAt: "soon" }), null);
    assert.equal(heldAtOf(null), null);
  });

  it("gives Fleet both medians, the held one over the runs that have held", () => {
    const clock = onboardingClock([
      { start: t("10:00"), signedOff: t("10:13"), firstAnswer: null, heldAt: t("10:19") },
      { start: t("11:00"), signedOff: t("11:22"), firstAnswer: null, heldAt: t("11:31") },
      { start: t("12:00"), signedOff: t("12:10"), firstAnswer: null, heldAt: null },
    ]);
    assert.equal(clock?.toSignOff, 13);
    assert.equal(clock?.held, 2);
    assert.equal(clock?.toHeld, 25, "median of 19 and 31");
    assert.equal(onboardingClock([{ start: t("10:00"), signedOff: t("10:13"), firstAnswer: null }])?.toHeld, undefined);
  });
});

describe("Fleet: customers needing attention after sign-off", () => {
  const q = (question: string, over: Record<string, unknown> = {}) => ({ question, answer: "A", sources: [], answered: true, ...over });
  const run = (questions: ReturnType<typeof q>[], extra: Record<string, unknown> = {}) =>
    ({ at: "2026-10-30T10:30:00Z", passed: false, questions, ...extra }) as unknown as ValidationResult;

  it("counts what the latest run left open on a signed-off deployment, and whether the console ran it", () => {
    const reopened = run([q("How much does DevCraft cost?", { flags: ["price"] }), q("A?")], { auto: "sync-finished" });
    assert.deepEqual(openSinceSignOff(true, reopened), { open: 1, auto: true });
    assert.deepEqual(openSinceSignOff(true, run([q("A?", { answered: false })])), { open: 1, auto: false });
    assert.equal(openSinceSignOff(false, reopened), undefined, "not signed off: onboarding, not a follow-up");
    assert.equal(openSinceSignOff(true, { ...reopened, passed: true }), undefined);
    const partial = run([q("A?", { answered: false })], { content: { answerable: 40, total: 190, partial: true } });
    assert.equal(openSinceSignOff(true, partial, t("10:31")), undefined, "a run on partial content runs again by itself");
  });

  it("keeps a starter the re-run removed until a person picks starters or signs off again", () => {
    const removed = {
      action: "deployment.starters.removed",
      at: t("10:40"),
      detail: { question: "How do I contact sales?", reason: "no answer" },
    };
    assert.deepEqual(startersRemoved([removed], t("10:13")), ["How do I contact sales?"]);
    assert.deepEqual(
      startersRemoved([removed, { action: "deployment.starters", at: t("10:50"), detail: { name: "Sam" } }], t("10:13")),
      [],
    );
    assert.deepEqual(
      startersRemoved([removed, { action: "deployment.starters", at: t("10:40"), detail: { auto: true } }], t("10:13")),
      ["How do I contact sales?"],
      "the removal's own change to the starters doesn't resolve it",
    );
    assert.deepEqual(startersRemoved([removed], t("10:45")), [], "removed before this sign-off");
    assert.deepEqual(startersRemoved([removed], undefined), []);
  });

  it("puts the customer under needing attention until it's resolved", () => {
    const d = { id: "d1", tenantId: "t1", name: "Main site", siteUrl: "https://www.telerik.com", status: "live", kbSlug: "k" };
    const after = { removed: ["How do I contact sales?"], open: { open: 2, auto: true } };
    assert.deepEqual(
      afterSignOffAlerts(d, after).map((a) => [a.tone, a.text, a.href]),
      [
        ["critical", "Starter “How do I contact sales?” removed: pick again", "/customers/t1/deployments/d1#validate"],
        ["warning", "Since sign-off: 2 answers open", "/customers/t1/deployments/d1#validate"],
      ],
    );
    const dash = (afterSignOff?: Map<string, typeof after>) =>
      buildDashboard({
        now: t("11:00"),
        tenants: [{ id: "t1", name: "Telerik (SE review r4)", status: "active", monthlyBudgetCents: null }],
        deployments: [d],
        usage: [],
        quality: [],
        syncs: [],
        ...(afterSignOff && { afterSignOff }),
      });
    assert.equal(dash(new Map([["d1", after]])).tenants[0]?.alerts.length, 2);
    assert.equal(dash().tenants[0]?.alerts.length, 0, "resolved: off the list");
  });
});

describe("the report in the month the declined rule ships", () => {
  it("carries one line, only in that month", () => {
    assert.equal(
      gapsRuleNote("2026-11", "2026-11-02"),
      "From 2 November 2026, replies that said “contact us” without answering count as gaps.",
    );
    assert.equal(gapsRuleNote("2026-12", "2026-11-02"), undefined);
    assert.equal(gapsRuleNote("2026-10", "2026-11-02"), undefined);
  });
});
