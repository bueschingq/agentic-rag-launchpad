import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ValidationResult } from "@launchpad/db";
import { isStoppedForBudget } from "../src/lib/budget.ts";
import { DEFAULT_EXCLUDES, parseContentForm } from "../src/lib/content-form.ts";
import { cspSnippet } from "../src/lib/csp.ts";
import { defaultStagingDomains, isStagingOrigin, liveWhere, missingTwins, parseDomains, twinOrigin } from "../src/lib/domain-rules.ts";
import { snippetInPlace } from "../src/lib/install-check.ts";
import {
  type ContentFacts,
  checklistSummary,
  type DeploymentFacts,
  deploymentStage,
  onboardingChecklist,
  onboardingClock,
  onboardingHeldAt,
  onboardingStart,
} from "../src/lib/onboarding.ts";
import { promptFromTemplate } from "../src/lib/prompt-templates.ts";
import type { ReviewLine } from "../src/lib/review.ts";
import { answerSources, parseGeneratedQuestions } from "../src/lib/validation-rules.ts";

const deployment = (over: Partial<DeploymentFacts> = {}): DeploymentFacts => ({
  status: "live",
  createdAt: new Date("2026-10-30T10:00:00Z"),
  readyAt: null,
  firstSeenAt: null,
  firstSeenOrigin: null,
  validation: null,
  preflight: null,
  ...over,
});
const content = (over: Partial<ContentFacts> = {}): ContentFacts => ({
  indexed: 0,
  total: 0,
  syncStatus: "running",
  syncError: null,
  connector: false,
  ...over,
});
const customer = { createdAt: new Date("2026-10-30T09:50:00Z"), paused: false, stoppedForBudget: false };
const passed: ValidationResult = {
  at: "2026-10-30T10:20:00Z",
  passed: true,
  questions: [1, 2, 3, 4].map((n) => ({
    question: `Q${n}?`,
    answer: "A",
    sources: [{ title: "t", url: "https://a.example/" }],
    answered: n !== 4,
  })),
};

describe("deploymentStage", () => {
  it("never calls a provisioned but empty deployment live", () => {
    const stage = deploymentStage(deployment(), content(), customer);
    assert.equal(stage.key, "indexing");
    assert.equal(stage.detail, "Finding the site's pages.");
    assert.equal(deploymentStage(deployment(), content({ indexed: 40, total: 200 }), customer).detail, "40 of 200 pages answerable.");
  });

  it("goes validate → review → ready only with a person's sign-off, and live after the first real chat", () => {
    const synced = content({ indexed: 40, total: 40, syncStatus: "ok" });
    const locked = { at: "", origins: [{ origin: "https://a.example", ok: true, status: 200 }] };
    assert.equal(deploymentStage(deployment(), synced, customer).label, "Ready to validate");
    // A pass, even an old one, isn't "Ready to embed" without a sign-off.
    const review = deploymentStage(deployment({ validation: passed, preflight: locked, readyAt: new Date() }), synced, customer);
    assert.equal(review.key, "review");
    assert.equal(deploymentStage(deployment({ validation: passed, preflight: locked, signOff: "signed" }), synced, customer).key, "ready");
    const changed = deploymentStage(deployment({ validation: passed, preflight: locked, signOff: "changed" }), synced, customer);
    assert.equal(changed.tone, "warning");
    // The header follows the latest run: a failed re-run isn't "Ready to embed".
    // Answers that failed: none of the questions answered.
    const failedRun = { ...passed, passed: false, questions: passed.questions.map((q) => ({ ...q, answered: false })) };
    assert.equal(
      deploymentStage(deployment({ validation: failedRun, preflight: locked }), synced, customer).label,
      "Validation: needs attention",
    );
    const seen = { firstSeenAt: new Date("2026-10-30T11:00:00Z"), firstSeenOrigin: "https://www.a.example" };
    const live = deploymentStage(deployment({ signOff: "signed", validation: passed, preflight: locked, ...seen }), content(), customer);
    assert.equal(live.key, "live");
    assert.equal(live.tone, "good");
    assert.match(live.detail, /www\.a\.example/);
    // A re-test that fails after sign-off undoes "Ready to embed", and turns Live red.
    const retest = deploymentStage(deployment({ validation: failedRun, preflight: locked, signOff: "signed" }), synced, customer);
    assert.deepEqual([retest.label, retest.tone], ["Re-test failed", "critical"]);
    const liveRetest = deploymentStage(
      deployment({ signOff: "signed", validation: failedRun, preflight: locked, ...seen }),
      content(),
      customer,
    );
    assert.deepEqual([liveRetest.tone, /latest validation failed/.test(liveRetest.detail)], ["critical", true]);
    // A domain lock nobody has confirmed (domains just changed) is flagged too.
    const unlocked = deploymentStage(deployment({ signOff: "signed", validation: passed, preflight: null, ...seen }), content(), customer);
    assert.deepEqual([unlocked.tone, /Domain lock not confirmed/.test(unlocked.detail)], ["warning", true]);
    // Live without a sign-off still serves, flagged.
    const unsigned = deploymentStage(
      deployment({ firstSeenAt: new Date(), firstSeenOrigin: "https://www.a.example" }),
      content(),
      customer,
    );
    assert.equal(unsigned.tone, "warning");
    assert.match(unsigned.detail, /Not signed off/);
  });

  it("treats a deployment visitors already use as live (imported ones)", () => {
    assert.equal(deploymentStage(deployment({ questions30: 12 }), content({ external: true }), customer).key, "live");
  });

  it("says where it's live: staging is a different state from the client's own site", () => {
    const locked = { at: "", origins: [{ origin: "https://www.client.com", ok: true, status: 200 }] };
    const signed = { signOff: "signed" as const, validation: passed, preflight: locked };
    const firstOnStaging = { firstSeenAt: new Date("2026-10-30T11:00:00Z"), firstSeenOrigin: "http://localhost:4174" };
    const staging = deploymentStage(deployment({ ...signed, ...firstOnStaging }), content(), customer);
    assert.equal(staging.label, "Live on staging (localhost:4174)");
    assert.match(staging.detail, /Not answering on a production domain yet/);
    // A marked staging domain counts the same as localhost.
    const marked = deploymentStage(
      deployment({
        ...signed,
        firstSeenAt: new Date(),
        firstSeenOrigin: "https://uat.client.com",
        stagingDomains: ["https://uat.client.com"],
      }),
      content(),
      customer,
    );
    assert.equal(marked.label, "Live on staging (uat.client.com)");
    // Answering on the production domain since: live there, whatever came first.
    const production = deploymentStage(
      deployment({ ...signed, ...firstOnStaging, answeredOn: ["http://localhost:4174", "https://www.client.com"] }),
      content(),
      customer,
    );
    assert.equal(production.label, "Live on www.client.com");
    // Imported, with questions but no origin on record: just Live.
    assert.equal(deploymentStage(deployment({ questions30: 12 }), content({ external: true }), customer).label, "Live");
  });

  it("flags a sign-off under older checks, and keeps it serving", () => {
    const locked = { at: "", origins: [{ origin: "https://www.a.example", ok: true, status: 200 }] };
    const seen = { firstSeenAt: new Date("2026-10-30T11:00:00Z"), firstSeenOrigin: "https://www.a.example" };
    const older = deploymentStage(
      deployment({ signOff: "signed", olderChecks: true, validation: passed, preflight: locked, ...seen }),
      content(),
      customer,
    );
    assert.deepEqual(
      [older.key, older.label, older.tone, older.flag],
      ["live", "Live on www.a.example", "warning", "Signed off under older checks"],
    );
    const ready = deploymentStage(
      deployment({ signOff: "signed", olderChecks: true, validation: passed, preflight: locked }),
      content(),
      customer,
    );
    assert.deepEqual([ready.key, ready.tone, ready.flag], ["ready", "warning", "Signed off under older checks"]);
    // Never signed off: nothing to bring up to date, so no flag.
    assert.equal(deploymentStage(deployment({ olderChecks: true, ...seen }), content(), customer).flag, undefined);
    const steps = onboardingChecklist({
      base: "/d",
      customerCreatedAt: new Date(),
      scanAt: null,
      review: [],
      deployment: deployment({ signOff: "signed", olderChecks: true, validation: passed, preflight: locked }),
      content: content({ indexed: 4, total: 4, syncStatus: "ok" }),
    });
    const signoff = steps.find((s) => s.key === "signoff");
    assert.deepEqual([signoff?.state, signoff?.action?.href], ["attention", "/d/review/up-to-date"]);
  });

  it("counts a snippet Check installation found as in place, before the first chat", () => {
    // kemptechnologies.com: found on staging 6 minutes before sign-off, then "waiting for the snippet".
    const locked = { at: "", origins: [{ origin: "http://localhost:4181", ok: true, status: 200 }] };
    const signed = { signOff: "signed" as const, validation: passed, preflight: locked };
    const snippetSeen = { at: new Date("2026-10-30T19:57:00Z"), origin: "http://localhost:4181" };
    const waiting = deploymentStage(deployment(signed), content(), customer);
    assert.equal(waiting.detail, "Signed off: waiting for the snippet on the site.");
    const found = deploymentStage(deployment({ ...signed, snippetSeen }), content(), customer);
    assert.deepEqual(
      [found.key, found.tone, found.detail],
      [
        "ready",
        "good",
        "Signed off, and the snippet is on localhost:4181 (Check installation, 2026-10-30 19:57 UTC): live with the first chat there.",
      ],
    );
    const steps = onboardingChecklist({
      base: "/d",
      customerCreatedAt: new Date(),
      scanAt: null,
      review: [],
      deployment: deployment({ ...signed, snippetSeen }),
      content: content({ indexed: 4, total: 4, syncStatus: "ok" }),
    });
    assert.match(steps.find((s) => s.key === "live")!.detail, /^The snippet is on localhost:4181 .*Live with the first chat there\.$/);
    // Only the snippet on one of the deployment's own domains counts.
    const checks = [{ label: "Snippet", result: "pass" as const, detail: "Found, for this deployment." }];
    assert.ok(snippetInPlace(checks, "http://localhost:4181", ["https://kemptechnologies.com", "http://localhost:4181"]));
    assert.ok(!snippetInPlace(checks, "https://other.example", ["https://kemptechnologies.com"]));
    assert.ok(!snippetInPlace([{ ...checks[0]!, result: "fail" }], "https://kemptechnologies.com", ["https://kemptechnologies.com"]));
  });

  it("puts pause, budget stop and failure ahead of everything else", () => {
    assert.equal(deploymentStage(deployment({ status: "paused", firstSeenAt: new Date() }), content(), customer).key, "paused");
    assert.equal(deploymentStage(deployment({ firstSeenAt: new Date() }), content(), { ...customer, paused: true }).key, "paused");
    assert.equal(
      deploymentStage(deployment({ firstSeenAt: new Date() }), content(), { ...customer, stoppedForBudget: true }).key,
      "offline",
    );
    const failed = deploymentStage(deployment({ status: "failed", failedStep: { step: "keys", detail: "403" } }), content(), customer);
    assert.equal(failed.detail, 'Stopped at "keys": 403');
  });
});

describe("onboardingChecklist", () => {
  const facts = (over: Partial<Parameters<typeof onboardingChecklist>[0]> = {}) => ({
    base: "/customers/c/deployments/d",
    customerCreatedAt: customer.createdAt,
    scanAt: null,
    review: [] as ReviewLine[],
    deployment: deployment(),
    content: content(),
    ...over,
  });

  it("has exactly one current step, with an action", () => {
    const steps = onboardingChecklist(facts());
    assert.equal(steps.filter((s) => s.state === "current").length, 1);
    const current = steps.find((s) => s.state === "current")!;
    assert.equal(current.key, "scan");
    assert.ok(current.action);
  });

  it("marks validation done only with answers and a locked domain", () => {
    const base = facts({ content: content({ indexed: 10, total: 10, syncStatus: "ok" }) });
    const unlocked = onboardingChecklist({
      ...base,
      deployment: deployment({
        validation: passed,
        preflight: { at: "", origins: [{ origin: "https://a.example", ok: false, status: 403 }] },
      }),
    });
    assert.equal(unlocked.find((s) => s.key === "validate")!.state, "attention");
    const locked = onboardingChecklist({
      ...base,
      deployment: deployment({
        validation: passed,
        preflight: { at: "", origins: [{ origin: "https://a.example", ok: true, status: 200 }] },
      }),
    });
    assert.equal(locked.find((s) => s.key === "validate")!.state, "done");
  });

  it("asks for a sign-off after validation, and keeps a one-line summary while steps are open", () => {
    const steps = onboardingChecklist(facts({ scanAt: new Date(), content: content({ indexed: 10, total: 10, syncStatus: "ok" }) }));
    assert.deepEqual(
      steps.map((s) => s.key),
      ["customer", "scan", "provision", "content", "brand", "handoff", "validate", "signoff", "live"],
    );
    assert.equal(steps.find((s) => s.key === "signoff")!.action?.href, "/customers/c/deployments/d/review");
    assert.match(checklistSummary(steps)!, /^Onboarding: 4 of 9 · Brand the widget, Handoff to a person, Validate/);
    const done = steps.map((s) => ({ ...s, state: "done" as const }));
    assert.equal(checklistSummary(done), undefined);
  });

  it("flags a failed sync with its reason", () => {
    const steps = onboardingChecklist(facts({ content: content({ syncStatus: "failed", syncError: "No pages found." }) }));
    const step = steps.find((s) => s.key === "content")!;
    assert.equal(step.state, "attention");
    assert.equal(step.detail, "No pages found.");
  });
});

describe("onboardingClock", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 10, minutes));
  it("is the median over real sign-offs, with the first answer counted separately", () => {
    const clock = onboardingClock([
      { start: t(0), signedOff: t(24), firstAnswer: t(31) },
      { start: t(0), signedOff: t(30), firstAnswer: null },
      { start: t(0), signedOff: t(28), firstAnswer: t(40) },
    ]);
    assert.deepEqual(clock, { count: 3, toSignOff: 28, toFirstAnswer: 36, answered: 2, held: 0 });
  });
  it("says nothing rather than 0 min when there's no real onboarding", () => {
    assert.equal(onboardingClock([]), undefined);
    // Seeded or imported: signed off before it started.
    assert.equal(onboardingClock([{ start: t(30), signedOff: t(0), firstAnswer: t(0) }]), undefined);
    // Serving before its first sign-off (from before the publish gate): a review, not an onboarding.
    assert.equal(onboardingClock([{ start: t(0), signedOff: t(50), firstAnswer: t(10) }]), undefined);
  });
});

describe("onboardingHeldAt (round 5, 7e: an upgrade sign-off never sets the clock)", () => {
  const at = (iso: string) => new Date(iso);
  it("keeps the heldAt of an onboarding signed off under checks that record it", () => {
    const signOff = { checksVersion: 3, heldAt: "2026-10-30T10:19:00.000Z" };
    assert.equal(onboardingHeldAt(signOff, null)?.toISOString(), "2026-10-30T10:19:00.000Z");
    // Still kept after a later upgrade sign-off, which carries it over.
    assert.equal(onboardingHeldAt(signOff, at("2026-12-01T09:00:00Z"))?.toISOString(), "2026-10-30T10:19:00.000Z");
  });

  it("drops a heldAt the upgrade sign-off stamped: the exec's round-4 deployment read 8 h 18 min", () => {
    // Signed off in round 4 (no heldAt then); Bring up to date and a new sign-off at 05:12:30 stamped it.
    const upgraded = { checksVersion: 3, heldAt: "2026-10-31T05:12:30.120Z" };
    assert.equal(onboardingHeldAt(upgraded, at("2026-10-31T05:12:30.180Z")), null);
    // The sign-off writes heldAt a moment before its audit entry, and after it too.
    assert.equal(onboardingHeldAt(upgraded, at("2026-10-31T05:12:30.050Z")), null);
  });

  it("drops a heldAt on a sign-off from before heldAt existed: an upgrade's validation run stamped it", () => {
    assert.equal(onboardingHeldAt({ checksVersion: 2, heldAt: "2026-10-31T05:10:00.000Z" }, null), null);
    assert.equal(onboardingHeldAt({ heldAt: "2026-10-31T05:10:00.000Z" }, null), null);
  });

  it("is nothing without a readable heldAt", () => {
    assert.equal(onboardingHeldAt(null, null), null);
    assert.equal(onboardingHeldAt({ checksVersion: 3 }, null), null);
    assert.equal(onboardingHeldAt({ checksVersion: 3, heldAt: "not a date" }, null), null);
  });

  it("leaves Fleet's median unchanged by an upgrade sign-off", () => {
    const t = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 10, minutes));
    const onboarded = { start: t(0), signedOff: t(13), firstAnswer: null, heldAt: t(19) };
    const before = onboardingClock([
      onboarded,
      // A round-4 deployment, not held yet.
      { start: t(0), signedOff: t(10), firstAnswer: null, heldAt: null },
    ]);
    const upgraded = { checksVersion: 3, heldAt: new Date(t(10).getTime() + 8 * 3_600_000 + 18 * 60_000).toISOString() };
    const after = onboardingClock([
      onboarded,
      { start: t(0), signedOff: t(10), firstAnswer: null, heldAt: onboardingHeldAt(upgraded, new Date(upgraded.heldAt)) },
    ]);
    assert.deepEqual(after, before);
    assert.equal(after?.toHeld, 19);
  });
});

describe("onboardingStart", () => {
  it("starts with a new customer, or with the deployment for an existing one", () => {
    const d = new Date("2026-10-30T10:00:00Z");
    assert.equal(onboardingStart(new Date("2026-10-30T09:40:00Z"), d).toISOString(), "2026-10-30T09:40:00.000Z");
    assert.equal(onboardingStart(new Date("2026-09-01T00:00:00Z"), d).toISOString(), d.toISOString());
  });
});

describe("validation", () => {
  it("parses generated questions, dropping numbering, duplicates and non-questions", () => {
    const text =
      '1. What are your opening hours?\n- Do you accept new patients?\nHere are some questions:\n"What are your opening hours?"\n4) How do I book?';
    assert.deepEqual(parseGeneratedQuestions(text), ["What are your opening hours?", "Do you accept new patients?", "How do I book?"]);
  });

  it("takes cited sources first, with http links only", () => {
    const result = {
      answer: "x",
      citations: { "r2/t/body/0-10": [[0, 10]] as [number, number][] },
      retrieval_results: {
        resources: {
          r1: { title: "One", origin: { url: "https://a.example/1" } },
          r2: { title: "Two", origin: { url: "https://a.example/2" } },
        },
      },
    };
    assert.deepEqual(answerSources(result), [{ title: "Two", url: "https://a.example/2" }]);
  });
  // Judging and passing (the shared verdict, own questions, flags): test/validation.test.ts.
});

describe("domains", () => {
  it("suggests the www or apex twin", () => {
    assert.equal(twinOrigin("https://www.client.com"), "https://client.com");
    assert.equal(twinOrigin("https://client.com"), "https://www.client.com");
    assert.equal(twinOrigin("https://shop.client.com"), undefined);
    assert.deepEqual(missingTwins(["https://www.client.com", "https://client.com"]), []);
  });

  it("parses one origin per line, and refuses junk", () => {
    assert.deepEqual(parseDomains("www.client.com\nhttps://uat.client.com/path"), {
      domains: ["https://www.client.com", "https://uat.client.com"],
    });
    assert.ok("error" in parseDomains("not a domain"));
    assert.ok("error" in parseDomains(""));
  });

  it("marks staging domains: extra ones by default on a new deployment, and this machine always", () => {
    assert.deepEqual(
      defaultStagingDomains("https://www.client.com/", [
        "https://www.client.com",
        "https://client.com",
        "https://uat.client.com",
        "http://localhost:4174",
      ]),
      ["https://uat.client.com", "http://localhost:4174"],
    );
    assert.ok(isStagingOrigin("http://localhost:4174", []));
    assert.ok(isStagingOrigin("http://127.0.0.1:8080", []));
    assert.ok(isStagingOrigin("https://uat.client.com", ["https://uat.client.com"]));
    assert.ok(!isStagingOrigin("https://www.client.com", ["https://uat.client.com"]));
    assert.deepEqual(liveWhere(["http://localhost:4174"], []), { staging: true, hosts: ["localhost:4174"] });
    assert.deepEqual(liveWhere(["http://localhost:4174", "https://www.client.com"], []), { staging: false, hosts: ["www.client.com"] });
    assert.equal(liveWhere([], []), undefined);
  });
});

describe("parseContentForm", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("keeps discovery on the deployment's own site", () => {
    const ok = parseContentForm(
      form({ startUrl: "client.com/en/", pageBudget: "300", exclude: "/search\n/news/*", resync: "168" }),
      "https://www.client.com",
    );
    assert.ok("value" in ok);
    assert.equal(ok.value.startUrl, "https://client.com/en/");
    assert.deepEqual(ok.value.exclude, ["/search", "/news/*"]);
    assert.equal(ok.value.resyncHours, 168);
    const elsewhere = parseContentForm(form({ startUrl: "https://other.example/" }), "https://www.client.com");
    assert.ok("errors" in elsewhere && elsewhere.errors.startUrl);
  });

  it("checks the budget and the path rules", () => {
    const bad = parseContentForm(form({ pageBudget: "0", include: "en" }), "https://www.client.com");
    assert.ok("errors" in bad && bad.errors.pageBudget && bad.errors.include);
    assert.ok(DEFAULT_EXCLUDES.includes("/sitefinity"));
  });
});

describe("cspSnippet", () => {
  it("names the console for scripts and calls, and the region for answers", () => {
    assert.equal(
      cspSnippet({
        consoleOrigin: "https://launchpad.agency.example",
        zone: "aws-us-east-2-1",
        avatarUrl: "https://cdn.client.com/logo.svg",
      }),
      "script-src https://launchpad.agency.example;\nconnect-src https://launchpad.agency.example https://aws-us-east-2-1.dp.progress.cloud;\nimg-src https://cdn.client.com",
    );
  });
});

describe("promptFromTemplate", () => {
  it("fills in the client and site, and refuses medical advice in healthcare", () => {
    const p = promptFromTemplate("healthcare", "Harbor View Dental", "https://www.harborview.example/");
    assert.match(p, /Harbor View Dental/);
    assert.match(p, /www\.harborview\.example/);
    assert.match(p, /never medical advice/);
    assert.doesNotMatch(promptFromTemplate("general", "A", "https://a.example"), /medical/);
  });
});

describe("isStoppedForBudget", () => {
  it("stops only in stop mode, at or over the budget", () => {
    assert.ok(isStoppedForBudget("stop", 10_000, 10_000));
    assert.ok(!isStoppedForBudget("alert", 10_000, 50_000));
    assert.ok(!isStoppedForBudget("stop", null, 50_000));
  });
});
