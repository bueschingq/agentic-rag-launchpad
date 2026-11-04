// Where a deployment stands, from data only: its stage (what the badge says), the onboarding
// checklist with one next action per step, and the onboarding timer. Pure, so it runs under
// node:test; the deployment page and the fleet feed it.
//
//   Draft → Provisioning → Indexing (n of N) → Ready to validate → Review and sign off →
//   Ready to embed → Live, plus Paused, Offline (over budget) and Failed.
//
// Review and sign off = the latest validation passed and every allowed domain passed the
// domain-lock check. Ready to embed = a named person signed off what visitors will see (the chat
// shows on sites only from then on). Live = the first chat session from an allowed domain.
// Nothing is marked done because a step merely ran.

import type { PreflightResult, ValidationResult } from "@launchpad/db";
import { liveWhere } from "./domain-rules.ts";
import type { ReviewLine } from "./review.ts";
import { isRefusalNote } from "./site-refusal.ts";
import { answersFailed, rerunsItself } from "./validation-rules.ts";

export type StageKey = "draft" | "provisioning" | "failed" | "indexing" | "validate" | "review" | "ready" | "live" | "paused" | "offline";

export interface Stage {
  key: StageKey;
  label: string;
  detail: string;
  tone: "good" | "neutral" | "warning" | "critical";
  // Said under the badge on Fleet and the customer page: "Signed off under older checks".
  flag?: string;
}

export const OLDER_CHECKS = "Signed off under older checks";

export interface DeploymentFacts {
  status: "draft" | "provisioning" | "live" | "paused" | "failed";
  createdAt: Date;
  readyAt: Date | null;
  firstSeenAt: Date | null;
  firstSeenOrigin: string | null;
  validation: ValidationResult | null;
  preflight: PreflightResult | null;
  failedStep?: { step: string; detail?: string };
  // Visitor questions in the last 30 days: a deployment already in use (imported ones were live
  // before the console knew them) is live whether or not the console saw its first chat.
  questions30?: number;
  // The review's sign-off: none yet, signed, or signed but changed since (it keeps serving).
  signOff?: "none" | "signed" | "changed";
  // Signed off before the review's current checks (review.ts CHECKS_VERSION).
  olderChecks?: boolean;
  // The deployment's staging domains, and the origins it answered visitors on in the last 30 days.
  stagingDomains?: readonly string[];
  answeredOn?: readonly string[];
  // The latest Check installation that found the snippet on an allowed domain (lib/install.ts):
  // it's in place, though no visitor has chatted yet.
  snippetSeen?: { at: Date; origin: string };
}

// "localhost:4181 (Check installation, 2026-10-30 19:57 UTC)"
const snippetWhere = (seen: { at: Date; origin: string }) =>
  `${seen.origin.replace(/^https?:\/\//, "")} (Check installation, ${seen.at.toISOString().slice(0, 16).replace("T", " ")} UTC)`;

export interface ContentFacts {
  indexed: number;
  // Pages found within the rules and budget, once a sync has listed them.
  total: number;
  syncStatus: string | null;
  syncError: string | null;
  connector: boolean;
  // Content put in the KB outside the console (imported deployments).
  external?: boolean;
  kbResources?: number;
  // "about 9 min left", while a sync loads pages (lib/content.ts syncEstimate).
  estimate?: string;
}

export interface CustomerFacts {
  createdAt: Date;
  paused: boolean;
  stoppedForBudget: boolean;
}

export const preflightPassed = (p: PreflightResult | null) => Boolean(p?.origins.length && p.origins.every((o) => o.ok));

export function deploymentStage(d: DeploymentFacts, content: ContentFacts, customer: CustomerFacts): Stage {
  if (d.status === "draft") return { key: "draft", label: "Draft", detail: "Not provisioned yet.", tone: "neutral" };
  if (d.status === "provisioning")
    return { key: "provisioning", label: "Provisioning", detail: "Creating the Knowledge Box and keys.", tone: "neutral" };
  if (d.status === "failed") {
    const step = d.failedStep
      ? `Stopped at "${d.failedStep.step}"${d.failedStep.detail ? `: ${d.failedStep.detail}` : "."}`
      : "Provisioning stopped.";
    return { key: "failed", label: "Failed", detail: step, tone: "critical" };
  }
  if (d.status === "paused") return { key: "paused", label: "Paused", detail: "Visitors see the offline message.", tone: "warning" };
  if (customer.paused)
    return { key: "paused", label: "Paused", detail: "The customer is paused, so visitors see the offline message.", tone: "warning" };
  if (customer.stoppedForBudget) {
    return {
      key: "offline",
      label: "Offline: budget",
      detail: "Over this month's budget, so visitors see the offline message.",
      tone: "critical",
    };
  }
  const signOff = d.signOff ?? "none";
  // Signed off before today's checks: it keeps serving, flagged until it's brought up to date.
  const older = signOff !== "none" && Boolean(d.olderChecks);
  const flag = older ? { flag: OLDER_CHECKS } : {};
  // Live without a current sign-off still serves, flagged until someone reviews it; so does a
  // re-test that failed after sign-off, and a domain lock nobody has confirmed.
  // After sign-off, a run whose answers failed is a failed re-test; one that only has flags waiting
  // for a person (a re-run that rewords a price) is a check, not a failure.
  const retestFailed = signOff !== "none" && d.validation !== null && !d.validation.passed && answersFailed(d.validation.questions);
  const checksWaiting = signOff !== "none" && d.validation !== null && !d.validation.passed && !retestFailed;
  const unsigned = [
    signOff === "none" ? "Not signed off." : signOff === "changed" ? "Changed since sign-off." : "",
    older ? "Signed off under older checks: bring it up to date." : "",
    retestFailed ? "The latest validation failed." : "",
    checksWaiting ? "The latest validation has answers to check." : "",
    !preflightPassed(d.preflight) ? "Domain lock not confirmed." : "",
  ]
    .filter(Boolean)
    .map((note) => ` ${note}`)
    .join("");
  const liveTone: Stage["tone"] = retestFailed ? "critical" : unsigned ? "warning" : "good";
  // "Live on staging (localhost:4174)" is not "Live on www.client.com": where it answered visitors
  // lately and where it first did. Answers recorded before the widget sent its origin have none,
  // so the first chat's origin always counts.
  const where = liveWhere([...(d.answeredOn ?? []), ...(d.firstSeenOrigin ? [d.firstSeenOrigin] : [])], d.stagingDomains ?? []);
  const liveLabel = !where
    ? "Live"
    : where.staging
      ? `Live on staging (${where.hosts.slice(0, 2).join(", ")}${where.hosts.length > 2 ? "…" : ""})`
      : `Live on ${where.hosts[0]}${where.hosts.length > 1 ? ` and ${where.hosts.length - 1} more` : ""}`;
  if (d.firstSeenAt) {
    return {
      key: "live",
      label: liveLabel,
      detail: `First chat on ${d.firstSeenOrigin ?? "the site"} on ${d.firstSeenAt.toISOString().slice(0, 10)}.${where?.staging ? " Not answering on a production domain yet." : ""}${unsigned}`,
      tone: liveTone,
      ...flag,
    };
  }
  if ((d.questions30 ?? 0) > 0) {
    return {
      key: "live",
      label: liveLabel,
      detail: `${d.questions30} visitor questions in the last 30 days.${unsigned}`,
      tone: liveTone,
      ...flag,
    };
  }
  if (retestFailed) {
    return {
      key: "validate",
      label: "Re-test failed",
      detail: "Signed off, but the latest validation failed: fix what it found and run it again before embedding.",
      tone: "critical",
    };
  }
  if (signOff !== "none") {
    return signOff === "changed"
      ? {
          key: "ready",
          label: "Ready to embed",
          detail: `Changed since sign-off: confirm the changes on the review.${older ? " Signed off under older checks: bring it up to date." : ""}`,
          tone: "warning",
          ...flag,
        }
      : older
        ? {
            key: "ready",
            label: "Ready to embed",
            detail: "Signed off under older checks: bring it up to date, then sign off again.",
            tone: "warning",
            ...flag,
          }
        : checksWaiting
          ? {
              key: "ready",
              label: "Ready to embed",
              detail: "Signed off; the latest validation has answers for a person to check before embedding.",
              tone: "warning",
            }
          : d.snippetSeen
            ? {
                key: "ready",
                label: "Ready to embed",
                detail: `Signed off, and the snippet is on ${snippetWhere(d.snippetSeen)}: live with the first chat there.`,
                tone: "good",
              }
            : { key: "ready", label: "Ready to embed", detail: "Signed off: waiting for the snippet on the site.", tone: "good" };
  }
  // The header follows the latest validation run, not the first one that passed.
  if (d.validation) {
    if (d.validation.passed && preflightPassed(d.preflight)) {
      return {
        key: "review",
        label: "Review and sign off",
        detail: "Tested and domain-locked. The chat shows on sites once a person signs it off.",
        tone: "neutral",
      };
    }
    const answered = d.validation.questions.filter((q) => q.answered).length;
    return {
      key: "validate",
      label: "Validation: needs attention",
      detail: d.validation.passed
        ? "Answers pass, but a domain isn't locked in yet."
        : `${answered} of ${d.validation.questions.length} test questions answered in the latest run.`,
      tone: "warning",
    };
  }
  const synced = content.indexed > 0 && (content.connector || content.external || ["ok", "partial"].includes(content.syncStatus ?? ""));
  if (synced) {
    return { key: "validate", label: "Ready to validate", detail: `${content.indexed} pages answerable: run validation.`, tone: "neutral" };
  }
  const pages = content.connector
    ? `${content.kbResources ?? 0} resources from Sitefinity's connector`
    : content.external && !content.total
      ? `${content.kbResources ?? "Some"} resources added outside Launchpad`
      : content.total
        ? `${content.indexed} of ${content.total} pages answerable`
        : content.syncStatus === "failed"
          ? "content sync failed"
          : "finding the site's pages";
  return { key: "indexing", label: "Indexing", detail: `${pages[0]!.toUpperCase()}${pages.slice(1)}.`, tone: "neutral" };
}

export type StepState = "done" | "current" | "todo" | "attention";

export interface ChecklistStep {
  key: "customer" | "scan" | "provision" | "content" | "brand" | "handoff" | "validate" | "signoff" | "live";
  label: string;
  state: StepState;
  detail: string;
  at?: Date;
  action?: { label: string; href: string };
}

export interface ChecklistFacts {
  base: string; // /customers/<id>/deployments/<id>
  customerCreatedAt: Date;
  scanAt: Date | null;
  // The review's lines (review.ts): brand and handoff come from there.
  review: ReviewLine[];
  signedOffAt?: Date;
  // A price table waits for a person: it comes before validation (build 8).
  priceTableOpen?: boolean;
  deployment: DeploymentFacts;
  content: ContentFacts;
}

export function onboardingChecklist(f: ChecklistFacts): ChecklistStep[] {
  const d = f.deployment;
  const brand = f.review.find((l) => l.key === "brand");
  const handoff = f.review.find((l) => l.key === "handoff");
  const provisioned = d.status === "live" || d.status === "paused";
  const v = d.validation;
  const answered = v?.questions.filter((q) => q.answered).length ?? 0;
  const contentReady =
    f.content.connector || f.content.external ? (f.content.kbResources ?? 0) > 0 || f.content.indexed > 0 : f.content.indexed > 0;

  const steps: ChecklistStep[] = [
    { key: "customer", label: "Customer", state: "done", detail: "Created.", at: f.customerCreatedAt },
    f.scanAt
      ? { key: "scan", label: "Scan the site", state: "done", detail: "Brand and site scanned.", at: f.scanAt }
      : {
          key: "scan",
          label: "Scan the site",
          state: "todo",
          detail: "Proposes the theme from the site.",
          action: { label: "Scan", href: `${f.base}/widget` },
        },
    d.status === "failed"
      ? {
          key: "provision",
          label: "Provision",
          state: "attention",
          detail: "Provisioning failed.",
          action: { label: "See why", href: `${f.base}#provisioning` },
        }
      : provisioned
        ? { key: "provision", label: "Provision", state: "done", detail: "Knowledge Box, keys and prompt in place." }
        : { key: "provision", label: "Provision", state: "current", detail: "Not finished yet." },
    !provisioned
      ? { key: "content", label: "Content", state: "todo", detail: "Starts after provisioning." }
      : (f.content.syncStatus === "failed" && !contentReady) || isRefusalNote(f.content.syncError)
        ? {
            key: "content",
            label: "Content",
            state: "attention",
            detail: f.content.syncError ?? "The sync failed.",
            action: { label: "Fix", href: `${f.base}#content` },
          }
        : contentReady && ["ok", "partial", null].includes(f.content.syncStatus) && !f.content.connector
          ? {
              key: "content",
              label: "Content",
              state: "done",
              detail: `${f.content.indexed} of ${f.content.total} pages answerable.`,
              action: { label: "Pages", href: `${f.base}/content` },
            }
          : contentReady && (f.content.connector || f.content.external)
            ? { key: "content", label: "Content", state: "done", detail: `${f.content.kbResources} resources in the Knowledge Box.` }
            : {
                key: "content",
                label: "Content",
                state: "current",
                detail: f.content.total
                  ? `${f.content.indexed} of ${f.content.total} pages answerable so far${f.content.estimate ? `, ${f.content.estimate}` : ""}. Do now: brand, handoff, starters and install; validation runs again by itself when the sync finishes.`
                  : "Finding the site's pages.",
                action: { label: "Watch", href: `${f.base}#content` },
              },
    brand?.state === "ok"
      ? { key: "brand", label: "Brand the widget", state: "done", detail: "Name, avatar and colors confirmed." }
      : {
          key: "brand",
          label: "Brand the widget",
          state: brand?.state === "check" ? "attention" : "todo",
          detail: brand?.detail ?? "Apply the scan, then confirm the name, avatar and colors.",
          action: { label: "Open", href: `${f.base}/widget#brand` },
        },
    handoff?.state === "ok" || handoff?.state === "skipped"
      ? { key: "handoff", label: "Handoff to a person", state: "done", detail: handoff.detail }
      : {
          key: "handoff",
          label: "Handoff to a person",
          state: "todo",
          detail: "Where visitors go when the chatbot can't help.",
          action: { label: "Set up", href: `${f.base}/widget#handoff` },
        },
    !contentReady
      ? { key: "validate", label: "Validate", state: "todo", detail: "Runs once pages are answerable." }
      : v?.passed && preflightPassed(d.preflight) && f.review.find((l) => l.key === "validation")?.state !== "check"
        ? {
            key: "validate",
            label: "Validate",
            state: "done",
            detail: `${answered} of ${v.questions.length} test questions answered with sources; domains locked.`,
            at: new Date(v.at),
          }
        : v
          ? {
              key: "validate",
              label: "Validate",
              state: "attention",
              detail:
                f.review.find((l) => l.key === "validation")?.state === "check"
                  ? (f.review.find((l) => l.key === "validation")?.detail ?? "Answers to check against the site.")
                  : rerunsItself(v)
                    ? "Ran during the first sync: it runs again by itself when the sync finishes."
                    : v.passed
                      ? "Answers pass, but a domain isn't locked in yet."
                      : `Only ${answered} of ${v.questions.length} test questions answered in the latest run.`,
              action: { label: "Run again", href: `${f.base}#validate` },
            }
          : {
              key: "validate",
              label: "Validate",
              state: "current",
              detail: f.priceTableOpen
                ? "Check the price table first: price answers are judged against it. Then test questions from the site's content."
                : "Test questions from the site's content.",
              action: f.priceTableOpen
                ? { label: "Check the price table", href: `${f.base}#price-table` }
                : { label: "Validate", href: `${f.base}#validate` },
            },
    d.signOff && d.signOff !== "none" && d.olderChecks
      ? {
          key: "signoff",
          label: "Review and sign off",
          state: "attention",
          detail: `Signed off under older checks${d.signOff === "changed" ? ", and changed since" : ""}: bring it up to date, then sign off again.`,
          action: { label: "Bring up to date", href: `${f.base}/review/up-to-date` },
        }
      : d.signOff === "signed"
        ? {
            key: "signoff",
            label: "Review and sign off",
            state: "done",
            detail: "A person checked what visitors will see.",
            at: f.signedOffAt,
          }
        : d.signOff === "changed"
          ? {
              key: "signoff",
              label: "Review and sign off",
              state: "attention",
              detail: "Changed since sign-off: confirm the changes.",
              action: { label: "Review", href: `${f.base}/review` },
            }
          : {
              key: "signoff",
              label: "Review and sign off",
              state: "todo",
              detail: "One screen: what visitors see, then sign off. The chat shows on sites from then on.",
              action: { label: "Review", href: `${f.base}/review` },
            },
    d.firstSeenAt
      ? { key: "live", label: "Go live", state: "done", detail: `First chat on ${d.firstSeenOrigin ?? "the site"}.`, at: d.firstSeenAt }
      : {
          key: "live",
          label: "Go live",
          state: d.signOff === "signed" ? "current" : "todo",
          detail: d.snippetSeen
            ? `The snippet is on ${snippetWhere(d.snippetSeen)}. Live with the first chat there${(d.signOff ?? "none") === "none" ? ", once it's signed off" : ""}.`
            : "Embed the snippet on the site. It can go on before sign-off: the chat appears once it's signed off.",
          action: { label: "Install guide", href: `${f.base}/install` },
        },
  ];
  // Exactly one step is current: the first that isn't done, unless it needs attention.
  const first = steps.find((s) => s.state !== "done");
  for (const s of steps) if (s.state === "current" && s !== first) s.state = "todo";
  if (first && first.state === "todo") first.state = "current";
  return steps;
}

// The one line a live deployment keeps until every step is done: "Onboarding: 7 of 9 · Handoff
// to a person not done". undefined once everything is.
export function checklistSummary(steps: ChecklistStep[]): string | undefined {
  const open = steps.filter((s) => s.state !== "done");
  if (!open.length) return undefined;
  const done = steps.length - open.length;
  return `Onboarding: ${done} of ${steps.length} · ${open.map((s) => s.label).join(", ")} still open`;
}

// ---- the onboarding clock ----

// The onboarding clock starts with the customer when the deployment followed within a few
// hours (a new client); for an existing customer's new site, with the deployment.
export function onboardingStart(customerCreatedAt: Date, deploymentCreatedAt: Date): Date {
  return deploymentCreatedAt.getTime() - customerCreatedAt.getTime() < 3 * 3_600_000 ? customerCreatedAt : deploymentCreatedAt;
}

// One onboarding: from the start (onboardingStart) to the first sign-off, and to the first
// answered question on an allowed domain. Only deployments a person signed off count, so seeded,
// imported and scripted ones (no sign-off on record) never set the number quoted to prospects.
// Nor do deployments that answered visitors before their first sign-off: they were serving
// before the publish gate existed, so their sign-off timed a review, not an onboarding.
export interface OnboardingRun {
  start: Date;
  signedOff: Date;
  firstAnswer: Date | null;
  // When the sign-off held (SignOff.heldAt): the automatic run after the first sync left nothing
  // open, or a person resolved what it opened.
  heldAt?: Date | null;
}

export interface OnboardingClock {
  count: number;
  toSignOff: number;
  // Median minutes to the first answer, over the runs that have one.
  toFirstAnswer?: number;
  answered: number;
  // Median minutes from the start to a sign-off that held after the first sync, over the runs
  // that have held: the figure sales quotes.
  toHeld?: number;
  held: number;
}

export function onboardingClock(runs: OnboardingRun[]): OnboardingClock | undefined {
  const real = runs.filter((r) => r.signedOff.getTime() >= r.start.getTime() && throughGate(r));
  if (!real.length) return undefined;
  const answered = real.filter((r) => r.firstAnswer && r.firstAnswer.getTime() >= r.start.getTime());
  const held = real.filter((r) => r.heldAt && r.heldAt.getTime() >= r.start.getTime());
  return {
    count: real.length,
    toSignOff: median(real.map((r) => minutesBetween(r.start, r.signedOff))),
    ...(answered.length && { toFirstAnswer: median(answered.map((r) => minutesBetween(r.start, r.firstAnswer!))) }),
    answered: answered.length,
    ...(held.length && { toHeld: median(held.map((r) => minutesBetween(r.start, r.heldAt!))) }),
    held: held.length,
  };
}

// The deployment's two clock figures: "Signed off 13 min after starting" and "Held after the
// first sync: 19 min" (or "not yet"), both from the start. None before the first sign-off. Pure.
export function clockFigures(started: Date, signedOffAt: Date | null, heldAt: Date | null | undefined): string[] {
  if (!signedOffAt) return [];
  return [
    `Signed off ${formatMinutes(minutesBetween(started, signedOffAt))} after starting`,
    `Held after the first sync: ${heldAt ? formatMinutes(minutesBetween(started, heldAt)) : "not yet"}`,
  ];
}

// SignOff.heldAt as a date, when it's set and readable.
export function heldAtOf(signOff: { heldAt?: string } | null | undefined): Date | null {
  const at = signOff?.heldAt ? new Date(signOff.heldAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

// heldAt came in with the review's checks 3 (lib/review.ts CHECKS_VERSION, 2026-10-30): one on an
// older sign-off was stamped later, by an upgrade's validation run, not by its onboarding.
export const HELD_SINCE_CHECKS = 3;
// The sign-off action stamps heldAt a moment before it writes its audit entry.
const SAME_SIGN_OFF_MS = 60_000;

// The sign-off's heldAt when it timed the onboarding: on a sign-off made under checks that record
// it, and before the deployment's first upgrade sign-off (the audit's deployment.signoff with a
// previousChecksVersion, from Bring up to date). An upgrade sign-off never sets the clock, on the
// deployment's page or in Fleet's median: exec review round 5, where a round-4 deployment brought
// up to date read "held after the first sync after 8 h 18 min". Pure.
export function onboardingHeldAt(
  signOff: { heldAt?: string; checksVersion?: number } | null | undefined,
  firstUpgradeAt: Date | null | undefined,
): Date | null {
  const held = heldAtOf(signOff);
  if (!held || (signOff?.checksVersion ?? 0) < HELD_SINCE_CHECKS) return null;
  return firstUpgradeAt && held.getTime() >= firstUpgradeAt.getTime() - SAME_SIGN_OFF_MS ? null : held;
}

// Onboarded through Review and sign off: nothing answered on the site before the sign-off.
export const throughGate = (r: OnboardingRun) => !r.firstAnswer || r.firstAnswer.getTime() >= r.signedOff.getTime();

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
