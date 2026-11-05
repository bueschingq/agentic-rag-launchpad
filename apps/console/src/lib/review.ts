// The review before "Ready to embed": one line per thing a visitor will meet, each green,
// skipped on purpose, or still to do, with where to fix it. Sign-off needs every required line
// green or skipped, and records who signed and a hash of what visitors see, so a later change
// shows "Changed since sign-off". Pure apart from the hash, so it runs under node:test.

import type {
  Confirmation,
  DeploymentConfirmations,
  LeadDelivery,
  PriceRow,
  PriceTable,
  PriceTableConfirmation,
  SignOff,
  ValidationResult,
} from "@launchpad/db";
import {
  confirmedTable,
  languageName,
  priceAmounts,
  priceRowsHash,
  resolveTheme,
  type ThemeInput,
  type WidgetSettings,
} from "@launchpad/theme";
import type { ConsoleUser } from "./auth.ts";
import { type ClientNameFacts, clientNameDetail, clientNameProblems } from "./client-name.ts";
import { formatPlanDay, intentName, type KeyIntent, noPriceTableNote, stillUnplaced } from "./content-plan.ts";
import { missingNeedsDecision } from "./site-refusal.ts";
import {
  chosenStarters,
  halfwayNote,
  partialContentNote,
  passedNote,
  passReasons,
  type reviewNotes,
  runCounts,
  startersNotAsked,
  thinRun,
  unacknowledgedFlags,
  validationPassed,
} from "./validation-rules.ts";

// The review's rules, stamped on each sign-off (SignOff.checksVersion). Raise it when a line
// starts checking something it didn't: deployments signed off before are flagged "signed off
// under older checks" (they keep serving) until someone brings them up to date and signs again.
//   1 (or none): until 2026-10-30, round 3.
//   2: Client's name reads the prompt, widget and lead email; pages dated by their own date;
//      starters and prices checked; removed questions shown.
//   3: (round 4) the intent questions (price, contact, support, buy, trial) asked and decided;
//      Check this answers (very short, or off-source) checked by a person; reworded no-answers
//      count as No answer; a pass with an undecided No answer says so; pages kept by hand despite
//      a date or stale-price rule shown with who and why.
export const CHECKS_VERSION = 3;

export const underOlderChecks = (signOff: Pick<SignOff, "checksVersion"> | null | undefined): boolean =>
  Boolean(signOff) && (signOff?.checksVersion ?? 0) < CHECKS_VERSION;

// What the latest validation run decided on the way past a problem, and what it asked of the
// starters and prices: reviewNotes() in validation-rules.ts.
export type ReviewNotes = ReturnType<typeof reviewNotes>;

export type LineState = "ok" | "skipped" | "todo" | "check" | "info";

export interface ReviewLine {
  key:
    | "brand"
    | "name"
    | "handoff"
    | "privacy"
    | "form"
    | "starters"
    | "languages"
    | "content"
    | "kept"
    | "keypages"
    | "missing"
    | "validation"
    | "prices"
    | "pricetable"
    | "ctas"
    | "analytics";
  label: string;
  state: LineState;
  detail: string;
  // Where to fix it, and the link's words when not "Fix it".
  href?: string;
  fix?: string;
  // Can be skipped on purpose from the review, with the consequence spelled out.
  skip?: { kind: Skippable; consequence: string; count?: number };
  // Holds up sign-off while it's "todo" or "check".
  required: boolean;
  // Offers "Run it now" (a run waiting for half the pages).
  runNow?: boolean;
}

// A page kept by hand although a date or stale-price rule leaves it out (track A's keptByHand).
export interface KeptFact {
  url: string;
  title?: string;
  rule: string;
  reason: string;
  name: string;
  verified: boolean;
  at: string;
}

export interface ReviewFacts {
  base: string;
  settings: WidgetSettings;
  // The deployment's answer language: a language, or "auto" for each visitor's.
  language: string;
  brand: "confirmed" | "changed" | "unconfirmed";
  confirmations: DeploymentConfirmations;
  leadDelivery: LeadDelivery;
  validation: ValidationResult | null;
  domainsLocked: boolean;
  content: { indexed: number; total: number; oldestTaken?: string; excluded?: number };
  // Served languages without consent text of their own, when the contact form is on.
  consentMissing?: string[];
  // Starter questions saved by the old one-click button, never chosen in the picker.
  startersUnchosen?: boolean;
  // What the chat calls the client, read from the prompt, the widget and the lead email.
  clientName?: ClientNameFacts;
  // The latest run's decisions and starter and price counts.
  notes?: ReviewNotes;
  // Signed off under older checks: whether Bring up to date applied today's content rules since,
  // and how many pages are still being extracted again.
  olderChecks?: { contentApplied: boolean; reextracting: number };
  // Pages kept by hand despite a date or stale-price rule (track A's keptByHand), with who and why.
  kept?: readonly KeptFact[];
  // Key pages the sync couldn't use (track A's keyPagesUnused), each with why and what to do.
  keyPagesUnused?: readonly { url: string; why: string }[];
  // Planned pages the site didn't let us read (lib/content.ts missingPages), and the sentence saying so.
  missingPages?: { missing: number; planned: number; keys: readonly { url: string; intent: KeyIntent }[]; note?: string };
}

// Review's line for key pages the sync couldn't use (a price page with almost no text, a contact
// page that's an error page): Check this, each with why and what to do. It doesn't hold up sign-off:
// the site is what it is, and the price and contact questions show what visitors get.
export function keyPagesLine(base: string, unused: readonly { url: string; why: string }[]): ReviewLine | undefined {
  if (!unused.length) return undefined;
  return {
    key: "keypages",
    label: "Key pages",
    state: "check",
    detail: `Check this: ${unused.length === 1 ? "1 key page" : `${unused.length} key pages`} the chat can't answer from. ${unused.map((u) => u.why).join(" ")}`,
    href: `${base}/content`,
    fix: "Open Content",
    required: false,
  };
}

// Review's words for pages kept by hand: "1 page kept by hand despite a stale price" (track A's
// keptSummary words it the same way).
function keptWords(kept: readonly KeptFact[]): string {
  const stale = (k: KeptFact) => /\bstates (a price|a discount or offer|a version)\b/.test(k.rule);
  const kinds = new Set(kept.map(stale));
  const why = kinds.size === 2 ? "a stale price or its date" : kinds.has(true) ? "a stale price" : "its date";
  return `${kept.length} ${kept.length === 1 ? "page" : "pages"} kept by hand despite ${why}`;
}

// Review's line for planned pages that aren't in the chat because the site didn't let us read them:
// how many, the key pages by name, and a decision by name to go ahead without them, which holds while
// no more than that many are missing. Not asked over a timeout or two (missingNeedsDecision).
export function missingPagesLine(
  base: string,
  m: NonNullable<ReviewFacts["missingPages"]>,
  decided: DeploymentConfirmations["missingPages"],
): ReviewLine | undefined {
  if (!missingNeedsDecision({ ...m, refused: Boolean(m.note) })) return undefined;
  const pages = `${m.missing} of the ${m.planned} planned ${m.planned === 1 ? "page" : "pages"}`;
  const keys = m.keys.slice(0, 6).map((k) => `${intentName(k.intent)} (${new URL(k.url).pathname})`);
  const among = keys.length
    ? ` Key pages among them: ${keys.join(", ")}${m.keys.length > keys.length ? `, and ${m.keys.length - keys.length} more` : ""}.`
    : "";
  const line = { key: "missing" as const, label: "Pages not read", href: `${base}/content`, fix: "Open Content", required: true };
  if (decided && decided.count >= m.missing) {
    return { ...line, state: "skipped", detail: `Going ahead without ${pages}, by choice (${who(decided)}).${among}` };
  }
  return {
    ...line,
    state: "todo",
    detail: `${pages} ${m.missing === 1 ? "isn't" : "aren't"} in the chat.${among}${m.note ? ` ${m.note}` : ""}`,
    skip: {
      kind: "missingPages",
      consequence: `The chat answers without these ${m.missing} ${m.missing === 1 ? "page" : "pages"} until a later sync reads them.`,
      count: m.missing,
    },
  };
}

// A call-to-action button that offers a price or a quote: fires on price talk, or names a quote.
const QUOTE_BUTTON =
  /pric|preis|precio|prix|prijs|preço|prezz|cost|kost|cuest|quote|angebot|presupuesto|cotiza|devis|offerte|orçamento|preventivo/i;
export const hasQuoteButton = (s: WidgetSettings): boolean =>
  (s.ctas ?? []).some((c) => QUOTE_BUTTON.test([c.label, c.url, ...(c.keywords ?? [])].join(" ")));

const hasHandoffContact = (s: WidgetSettings) => (s.handoff?.contacts ?? []).some((c) => c.url.replace(/^(tel:|mailto:)/, "").trim());
// Parts a person may leave out on purpose, and the review line each belongs to.
export type Skippable = "noHandoff" | "noPrivacy" | "genericConsent" | "missingPages";
export const SKIP_FOR_LINE: Record<string, Skippable> = {
  handoff: "noHandoff",
  privacy: "noPrivacy",
  form: "genericConsent",
  missing: "missingPages",
};

const leadDestination = (d: LeadDelivery) => Boolean(d.webhookUrl || d.emails?.length);
// Where leads go, in words: "the webhook at hooks.slack.com" or "sales@client.example".
function leadTarget(d: LeadDelivery): string {
  const to = [...(d.webhookUrl ? [`the webhook at ${new URL(d.webhookUrl).host}`] : []), ...(d.emails ?? [])];
  return to.length > 1 ? `${to.slice(0, -1).join(", ")} and ${to.at(-1)}` : (to[0] ?? "");
}
const who = (c: Confirmation) => `${c.name}, ${c.at.slice(0, 16).replace("T", " ")} UTC`;

// Review's line for pages kept by hand despite a date or stale-price rule: Check this, with each
// page, the rule, who kept it and why. It doesn't hold up sign-off: a person already decided, with a
// name and a reason, and Review shows it to the person who signs off.
export function keptLine(base: string, kept: readonly KeptFact[]): ReviewLine | undefined {
  if (!kept.length) return undefined;
  return {
    key: "kept",
    label: "Pages kept by hand",
    state: "check",
    detail: `Check this: ${keptWords(kept)}: ${kept
      .map(
        (k) =>
          `${k.title ?? new URL(k.url).pathname} (${k.rule.replace(/\.$/, "")}), kept by ${k.name}${k.verified || /not verified/.test(k.name) ? "" : " (not verified)"}: ${k.reason.replace(/\.$/, "")}`,
      )
      .join("; ")}.`,
    href: `${base}/content`,
    fix: "Open Content",
    required: false,
  };
}

export function reviewLines(f: ReviewFacts): ReviewLine[] {
  const s = f.settings;
  const form = Boolean(s.lead?.enabled);
  // Flags and weak language readings a person hasn't checked yet.
  const unacknowledged = unacknowledgedFlags(f.validation);
  const lines: ReviewLine[] = [];

  lines.push(
    f.brand === "confirmed"
      ? { key: "brand", label: "Brand", state: "ok", detail: "Name, avatar and colors confirmed.", required: true }
      : {
          key: "brand",
          label: "Brand",
          state: f.brand === "changed" ? "check" : "todo",
          detail:
            f.brand === "changed"
              ? "The name, avatar or primary color changed after it was confirmed: confirm it again."
              : "Confirm the chat name, avatar and colors at their real size.",
          href: `${f.base}/widget#brand`,
          required: true,
        },
  );

  // The client's name in answers, the widget and lead emails, read from what's saved: never the
  // partner's own label for the customer, and no prompt line that invites leaks.
  if (f.clientName) {
    const problems = clientNameProblems(f.clientName);
    const first = problems[0];
    const detail = clientNameDetail(problems, f.clientName);
    const inWidget = first?.kind === "other-name" && first.where !== "the saved prompt" && !first.where.startsWith("the prompt");
    lines.push(
      !first
        ? { key: "name", label: "Client's name", state: "ok", detail, required: true }
        : first.kind === "no-name" || (first.kind === "other-name" && first.where === "the lead email")
          ? {
              key: "name",
              label: "Client's name",
              state: "todo",
              detail,
              href: `${f.base.split("/deployments/")[0]}/edit#displayName`,
              required: true,
            }
          : inWidget
            ? { key: "name", label: "Client's name", state: "check", detail, href: `${f.base}/widget`, required: true }
            : {
                key: "name",
                label: "Client's name",
                state: "check",
                detail,
                href: `${f.base}/review/prompt`,
                fix: "Update the prompt",
                required: true,
              },
    );
  }

  const handoffOk = hasHandoffContact(s) || (form && leadDestination(f.leadDelivery));
  lines.push(
    handoffOk
      ? {
          key: "handoff",
          label: "Handoff",
          state: "ok",
          detail: hasHandoffContact(s)
            ? "Visitors who get no answer can reach the team."
            : "Visitors who get no answer can send the contact form.",
          required: true,
        }
      : f.confirmations.noHandoff
        ? {
            key: "handoff",
            label: "Handoff",
            state: "skipped",
            detail: `No handoff, by choice (${who(f.confirmations.noHandoff)}).`,
            href: `${f.base}/widget#handoff`,
            required: true,
          }
        : {
            key: "handoff",
            label: "Handoff",
            state: "todo",
            detail: "Not set up: a visitor who gets no answer has nowhere to go.",
            href: `${f.base}/widget#handoff`,
            skip: { kind: "noHandoff", consequence: "Visitors who get no answer have no way to reach the team." },
            required: true,
          },
  );

  lines.push(
    s.privacyUrl
      ? { key: "privacy", label: "Privacy notice", state: "ok", detail: "Linked from the AI disclosure line.", required: true }
      : form
        ? {
            key: "privacy",
            label: "Privacy notice",
            state: "todo",
            detail: "Required while the contact form is on: visitors consent to it.",
            href: `${f.base}/widget#privacy`,
            required: true,
          }
        : f.confirmations.noPrivacy
          ? {
              key: "privacy",
              label: "Privacy notice",
              state: "skipped",
              detail: `No privacy link, by choice (${who(f.confirmations.noPrivacy)}).`,
              href: `${f.base}/widget#privacy`,
              required: true,
            }
          : {
              key: "privacy",
              label: "Privacy notice",
              state: "todo",
              detail: "No link to the client's privacy notice.",
              href: `${f.base}/widget#privacy`,
              skip: { kind: "noPrivacy", consequence: "The chat shows no link to the client's privacy notice." },
              required: true,
            },
  );

  if (form) {
    const missing = f.consentMissing ?? [];
    lines.push(
      !leadDestination(f.leadDelivery)
        ? {
            key: "form",
            label: "Contact form",
            state: "todo",
            detail: "On, but leads have nowhere to go: set a webhook or email.",
            href: `${f.base}/edit#leads`,
            required: true,
          }
        : missing.length && f.confirmations.genericConsent
          ? {
              key: "form",
              label: "Contact form",
              state: "skipped",
              detail: `Leads go to ${leadTarget(f.leadDelivery)}. Generic ${missing.join(", ")} consent wording kept, by choice (${who(f.confirmations.genericConsent)}).`,
              href: `${f.base}/widget#form`,
              required: true,
            }
          : missing.length
            ? {
                key: "form",
                label: "Contact form",
                state: "check",
                detail: `Leads go to ${leadTarget(f.leadDelivery)}. Check this: ${missing.join(", ")} consent text is the generic default, not the client's own wording.`,
                href: `${f.base}/widget#form`,
                skip: {
                  kind: "genericConsent",
                  consequence: `Visitors in ${missing.join(", ")} agree to the widget's generic wording, which the client's privacy team hasn't approved.`,
                },
                required: true,
              }
            : { key: "form", label: "Contact form", state: "ok", detail: `On; leads go to ${leadTarget(f.leadDelivery)}.`, required: true },
    );
  } else lines.push({ key: "form", label: "Contact form", state: "info", detail: "Off.", href: `${f.base}/widget#form`, required: false });

  const starters = s.starters?.length ?? 0;
  const n = f.notes;
  // The starters' own prices: checked by whom, and still to check.
  const sp = n?.starterPrices;
  const prices = sp
    ? [
        sp.checked
          ? `${sp.checked} price${sp.checked === 1 ? "" : "s"} checked${sp.checkedBy.length ? ` by ${sp.checkedBy.join(" and ")}` : ""}`
          : "",
        sp.toCheck ? `${sp.toCheck} price${sp.toCheck === 1 ? "" : "s"} to check` : "",
      ].filter(Boolean)
    : [];
  // Each further language has its own starters, and one without them shows its visitors none.
  const bare = starters && f.language === "auto" ? (s.languages ?? []).slice(1).filter((l) => !s.translations?.[l]?.starters?.length) : [];
  const names = bare.map(languageName);
  const bareNote = names.length
    ? `${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]} visitors see none (add theirs in Widget, Languages)`
    : "";
  // Chosen starters are asked in every run; one that wasn't asked, or got no answer, isn't done.
  const startersUnasked = n && starters ? startersNotAsked(f.validation, chosenStarters(s)).length : 0;
  const startersUnanswered = n ? Math.max(0, n.startersAsked - n.startersAnswered) : 0;
  // Starters the automatic re-run took off the live chat (no answer, twice), since anyone chose them.
  const chosenAt = f.confirmations.starters?.at ?? "";
  const pulled = (n?.startersRemoved ?? []).filter((r) => r.at > chosenAt);
  const pulledNote = pulled.length
    ? `${pulled.map((r) => `“${r.question}”`).join(", ")} removed from the chat after the automatic re-run (${pulled[0]?.reason ?? "no answer"}): pick again`
    : "";
  lines.push(
    f.confirmations.starters && !f.startersUnchosen && n && (startersUnasked || startersUnanswered || sp?.toCheck || pulled.length)
      ? {
          key: "starters",
          label: "Starter questions",
          state: "check",
          detail: [
            `${starters} chosen by ${f.confirmations.starters.name}, ${n.startersAnswered} answered`,
            ...prices,
            startersUnasked ? `${startersUnasked} not asked in the latest validation run: run it again` : "",
            startersUnanswered ? `${startersUnanswered} got no answer: visitors tap these first` : "",
            pulledNote,
            bareNote,
          ]
            .filter(Boolean)
            .join("; ")
            .concat("."),
          href: `${f.base}#validate`,
          required: true,
        }
      : f.confirmations.starters && !f.startersUnchosen
        ? {
            key: "starters",
            label: "Starter questions",
            state: "ok",
            detail: !starters
              ? `None, by choice (${f.confirmations.starters.name}).`
              : n
                ? [`${starters} chosen by ${f.confirmations.starters.name}, ${n.startersAnswered} answered`, ...prices]
                    .join(", ")
                    .concat(bareNote ? `; ${bareNote}.` : ".")
                : `${starters} chosen by ${f.confirmations.starters.name}${bareNote ? `; ${bareNote}` : ""}.`,
            ...(bareNote && { href: `${f.base}/widget#languages` }),
            required: true,
          }
        : {
            key: "starters",
            label: "Starter questions",
            state: starters ? "check" : "todo",
            detail: starters
              ? "Check this: they were saved in one click and nobody chose them."
              : "Choose the questions visitors see first, or none.",
            href: `${f.base}#validate`,
            required: true,
          },
  );

  const served = f.language !== "auto" ? f.language : s.languages?.length ? s.languages.join(", ") : "each visitor's language";
  lines.push({ key: "languages", label: "Languages", state: "info", detail: `Serves ${served}.`, required: false });

  const older = f.olderChecks;
  lines.push(
    older && (!older.contentApplied || older.reextracting > 0)
      ? {
          key: "content",
          label: "Content",
          state: "check",
          detail: older.contentApplied
            ? `Check this: signed off under older checks, and ${older.reextracting} page${older.reextracting === 1 ? " is" : "s are"} still being read again with today's extractor.`
            : "Check this: signed off under older checks. Bring up to date reads every page again, shows what today's rules would leave out and which key pages would join, offers the current prompt and runs validation again with the questions every site gets.",
          href: `${f.base}/review/up-to-date`,
          fix: "Bring up to date",
          required: true,
        }
      : f.content.indexed > 0
        ? {
            key: "content",
            label: "Content",
            state: "ok",
            detail: [
              `${f.content.indexed} of ${f.content.total} pages answerable`,
              f.content.oldestTaken && `oldest page taken ${formatPlanDay(f.content.oldestTaken)}`,
              f.content.excluded && `${f.content.excluded} left out by the rules`,
            ]
              .filter(Boolean)
              .join("; ")
              .concat("."),
            href: `${f.base}/content`,
            required: true,
          }
        : {
            key: "content",
            label: "Content",
            state: "todo",
            detail: "No answerable pages yet.",
            href: `${f.base}#content`,
            required: true,
          },
  );

  const kept = keptLine(f.base, f.kept ?? []);
  if (kept) lines.push(kept);
  const unusedKeys = keyPagesLine(f.base, f.keyPagesUnused ?? []);
  if (unusedKeys) lines.push(unusedKeys);
  const missing = f.missingPages && missingPagesLine(f.base, f.missingPages, f.confirmations.missingPages);
  if (missing) lines.push(missing);

  const v = f.validation;
  // Runs saved before today's rules are judged by them too ("tell me about" questions don't count).
  // Starters saved outside the picker count too: every chosen one must have been asked.
  const passed = Boolean(v?.passed && validationPassed(v.questions, chosenStarters(s)));
  const reasons = passReasons(v);
  const fallback = v ? runCounts(v.questions).fallback : 0;
  const notCounted = fallback ? ` ${fallback} "tell me about" question${fallback === 1 ? " isn't" : "s aren't"} counted.` : "";
  // A run early in the first sync, with under half the pages answerable, tested too little.
  const thin = thinRun(v);
  // "Runs again by itself at 98 of 195 pages answerable (now 83, about 3 min)", with Run it now.
  const halfway = thin ? halfwayNote(v, { answerable: f.content.indexed, total: f.content.total }) : undefined;
  // "Passed: 1 question with No answer and no decision", and which.
  const undecided = passedNote(v);
  const undecidedList = n?.noDecision.length ? `: ${n.noDecision.map((q) => `“${q}”`).join(", ")}` : "";
  lines.push(
    !v
      ? { key: "validation", label: "Validation", state: "todo", detail: "Not run yet.", href: `${f.base}#validate`, required: true }
      : unacknowledged
        ? {
            key: "validation",
            label: "Validation",
            state: "check",
            // Failures and checks together, so one pass through the panel clears them all; and when the
            // run was thin, when it runs again by itself (round 5: the price check hid that line).
            detail: `${
              reasons.length
                ? `To pass: ${reasons.join(", ")}.`
                : `${unacknowledged} answer${unacknowledged === 1 ? "" : "s"} to check against the site (prices, dates, overview pages).`
            }${thin && halfway ? ` ${halfway}` : ""}`,
            href: `${f.base}#validate`,
            required: true,
            ...(thin && { runNow: true }),
          }
        : thin
          ? {
              key: "validation",
              label: "Validation",
              state: passed ? "check" : "todo",
              detail: `${halfway ?? partialContentNote(v) ?? "Ran on partial content: run it again."}${
                passed ? "" : ` The latest run didn't pass${reasons.length ? `: ${reasons.join(", ")}` : ""}.`
              }`,
              href: `${f.base}#validate`,
              required: true,
              runNow: true,
            }
          : passed && f.domainsLocked
            ? {
                key: "validation",
                label: "Validation",
                state: "ok",
                detail: `${undecided ? `${undecided}${undecidedList}.` : "Passed."} Every domain is locked in.${notCounted}${partialContentNote(v) ? ` ${partialContentNote(v)}` : ""}`,
                required: true,
              }
            : {
                key: "validation",
                label: "Validation",
                state: "todo",
                detail: passed
                  ? "Answers pass, but a domain isn't locked in yet."
                  : `The latest run didn't pass${reasons.length ? `: ${reasons.join(", ")}` : ""}.${notCounted}`,
                href: `${f.base}#validate`,
                required: true,
              },
  );

  if (n?.priceNotCovered && !hasQuoteButton(s)) {
    lines.push({
      key: "prices",
      label: "Price questions",
      state: "check",
      detail:
        "Check this: price questions have no answer and no quote button. Visitors who ask a price get the no-answer reply: add a button that offers a quote or the contact page when they ask about prices.",
      href: `${f.base}/widget#ctas`,
      fix: "Add a button",
      required: false,
    });
  }

  const ctas = s.ctas?.length ?? 0;
  lines.push({
    key: "ctas",
    label: "Call-to-action buttons",
    state: "info",
    detail: ctas ? `${ctas} set.` : "None.",
    href: `${f.base}/widget#ctas`,
    required: false,
  });
  lines.push({
    key: "analytics",
    label: "Google Analytics",
    state: "info",
    detail: s.analytics?.googleAnalytics ? "Events go to the site's own GA." : "Off.",
    href: `${f.base}/widget#analytics`,
    required: false,
  });
  return lines;
}

export const canSignOff = (lines: ReviewLine[]) => lines.every((l) => !l.required || l.state === "ok" || l.state === "skipped");

// Whether the brand a person confirmed is still what's saved: the chat name, the avatar and the
// primary color. Fonts and the other colors follow the scan and don't need a second look.
export function brandStatus(
  settings: WidgetSettings,
  theme: ThemeInput,
  confirmations: DeploymentConfirmations,
): "confirmed" | "changed" | "unconfirmed" {
  const confirmed = confirmations.brand;
  if (!confirmed) return "unconfirmed";
  const now = { nickname: settings.nickname, avatar: settings.avatar, primary: resolveTheme(theme).theme.color.primary.toLowerCase() };
  const then = confirmed.values;
  return now.nickname === then.nickname && now.avatar === then.avatar && now.primary === then.primary.toLowerCase()
    ? "confirmed"
    : "changed";
}

// The hash lives with the schema, so the demo seed signs off the same way.
export { visitorSettingsHash } from "@launchpad/db";

export type SignOffState =
  | { state: "none" }
  | { state: "signed"; signOff: SignOff }
  // nameChanged: "Name visitors see" changed after the sign-off (it's the customer's, not in the hash).
  // contentChanged: pages added, kept or left out by hand, key pages added or the content settings
  // changed after the sign-off, and still different (lib/content.ts contentChangesSince).
  // priceChanged: the confirmed price table isn't the one signed off (priceTableChanged).
  | { state: "changed"; signOff: SignOff; nameChanged?: boolean; contentChanged?: boolean; priceChanged?: boolean };

export function signOffState(
  signOff: SignOff | null,
  currentHash: string,
  nameChangedAt?: Date | null,
  // The latest content change since the sign-off that still stands.
  contentChangedAt?: Date | string | null,
  priceChanged = false,
): SignOffState {
  if (!signOff) return { state: "none" };
  const since = Date.parse(signOff.at);
  const after = (at: Date | string | null | undefined) => Boolean(at && new Date(at).getTime() > since);
  const nameChanged = after(nameChangedAt);
  const contentChanged = after(contentChangedAt);
  if (signOff.settingsHash === currentHash && !nameChanged && !contentChanged && !priceChanged) return { state: "signed", signOff };
  return {
    state: "changed",
    signOff,
    ...(nameChanged && { nameChanged }),
    ...(contentChanged && { contentChanged }),
    ...(priceChanged && { priceChanged }),
  };
}

// The hash a sign-off records: what the chat checks price answers against, "" for nothing confirmed.
type WithPriceTable = { priceTable?: PriceTable | null; priceTableConfirmation?: PriceTableConfirmation | null };
export const signedPriceHash = (d: WithPriceTable): string => confirmedTable(d)?.hash ?? "";

// Whether the price table changed since a sign-off: it changes what visitors read, so it counts like
// any other change (build 8). Changed and changed back drops out. A sign-off from before recorded no
// hash: its table changed when it was confirmed later, or isn't confirmed for these rows now. Pure.
export function priceTableChanged(signOff: SignOff | null, d: WithPriceTable): boolean {
  if (!signOff) return false;
  if (signOff.priceTableHash !== undefined) return signOff.priceTableHash !== signedPriceHash(d);
  const c = d.priceTableConfirmation;
  if (!d.priceTable?.rows.length || !c) return Boolean(d.priceTable?.edited?.length);
  return c.hash !== d.priceTable.hash || Date.parse(c.at) > Date.parse(signOff.at);
}

// A content change since the sign-off (lib/content.ts ContentChange), as Review's change list
// says it after who made it: "added /contact by hand", "kept /blog/cost by hand despite a stale
// price (“The client confirmed it.”)".
export interface ContentChangeFact {
  kind: "added" | "kept" | "left-out" | "key-pages" | "settings";
  url?: string;
  label: string;
  reason?: string;
}

const changePath = (c: ContentChangeFact) => {
  if (c.url) {
    try {
      return new URL(c.url).pathname;
    } catch {
      return c.url;
    }
  }
  const colon = c.label.indexOf(": ");
  return colon >= 0 ? c.label.slice(colon + 2) : c.label;
};

export function contentChangeWords(c: ContentChangeFact): string {
  const what = changePath(c);
  const reason = c.reason?.trim() ? ` (“${c.reason.trim().replace(/\.$/, "")}”)` : "";
  switch (c.kind) {
    case "added":
      return `added ${what} by hand`;
    case "kept":
      return `kept ${what} by hand despite ${/stale price/.test(c.label) ? "a stale price" : "its date"}${reason}`;
    case "left-out":
      return `left ${what} out by hand`;
    case "key-pages":
      return `added the key pages ${what}`;
    default:
      return `changed the content settings (${what})`;
  }
}

// The deployment page's line for the same changes: "1 page added by hand and 1 left out".
export function contentChangeSummary(changes: readonly ContentChangeFact[]): string {
  const added = changes.filter((c) => c.kind === "added" || c.kind === "kept").length;
  const left = changes.filter((c) => c.kind === "left-out").length;
  const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
  const parts = [
    added ? `${pages(added)} added by hand` : "",
    left ? `${added ? left : pages(left)} left out by hand` : "",
    changes.some((c) => c.kind === "key-pages") ? "key pages added" : "",
    changes.some((c) => c.kind === "settings") ? "the content settings changed" : "",
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

// What the review's sign-off button offers: a first sign-off, one for the changes since, one
// under today's checks, or none while the sign-off stands (nothing visitors see has changed and
// the checks are today's: a validation run after it needs fixing when it fails, not a new one).
export type SignOffOffer = "first" | "changes" | "checks";
export function signOffOffer(signOff: SignOffState["state"], olderChecks: boolean): SignOffOffer | undefined {
  if (signOff === "none") return "first";
  if (signOff === "changed") return "changes";
  return olderChecks ? "checks" : undefined;
}

// Decisions taken on the way past a failed question, for Review to show above the sign-off
// button: "“How much is it?” removed after No answer, by Quinton: not on the site yet", or "removed after
// failing: Talks about how it works internally" (round 6: every removal read "after No answer").
export function reviewDecisions(notes: ReviewNotes | undefined): string[] {
  if (!notes) return [];
  const when = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;
  return [
    ...notes.removed.map(
      (r) =>
        `“${r.question}” removed after ${(r.was ?? "No answer").replace(/^Failed: /, "failing: ").replace(/^A /, "a ")}, by ${r.name} (${when(r.at)}): ${r.reason}`,
    ),
    ...notes.notCovered.map((r) => `“${r.question}”: the site doesn't cover this, by ${r.name} (${when(r.at)}): ${r.reason}`),
    // Held answers a person kept as answered (round 6, item 6), with what held them.
    ...(notes.kept ?? []).map(
      (r) => `“${r.question}” kept as answered (held: ${r.held.replace(/\.$/, "")}), by ${r.name} (${when(r.at)}): ${r.reason}`,
    ),
  ];
}

// ---- the price table (round 6, item 1) ----

export type PriceTableState = "none" | "confirmed" | "changed" | "unconfirmed";

// Where the table stands: none (no pricing page, or prices by quote: nothing to confirm), confirmed
// for these rows, changed since it was confirmed (a re-read changed the rows), or never confirmed.
export function priceTableState(
  table: PriceTable | null | undefined,
  confirmation: PriceTableConfirmation | null | undefined,
): PriceTableState {
  if (!table?.rows.length) return "none";
  if (!confirmation) return "unconfirmed";
  return confirmation.hash === table.hash ? "confirmed" : "changed";
}

// Review's line for the price table. Confirming it holds up sign-off only when there's a table: a
// site with no pricing page or prices by quote has none, and the line says so.
export function priceTableLine(
  base: string,
  table: PriceTable | null | undefined,
  confirmation: PriceTableConfirmation | null | undefined,
  // false: no page has been read yet; "reading": the first sync is running (noPriceTableNote).
  read: boolean | "reading" = true,
): ReviewLine {
  const state = priceTableState(table, confirmation);
  const href = `${base}#price-table`;
  if (state === "none") {
    const unread = table?.gap?.kind === "unread";
    return {
      key: "pricetable",
      label: "Price table",
      state: unread ? "check" : "info",
      detail: noPriceTableNote(table, read),
      ...(unread && { href }),
      required: false,
    };
  }
  const n = table?.rows.length ?? 0;
  if (state === "confirmed")
    return {
      key: "pricetable",
      label: "Price table",
      state: "ok",
      detail: `${n} price${n === 1 ? "" : "s"} confirmed against the pricing page by ${confirmation?.by} (${confirmation?.at.slice(0, 16).replace("T", " ")} UTC)${confirmation?.edited?.length ? `, ${confirmation.edited.length} corrected by hand` : ""}. Every price answer is checked against it.`,
      href,
      required: true,
    };
  return {
    key: "pricetable",
    label: "Price table",
    state: state === "changed" ? "check" : "todo",
    detail:
      state === "changed"
        ? `The pricing page changed since ${confirmation?.by} confirmed the table${table?.changes?.length ? ` (${table.changes.join("; ")})` : ""}: check its ${n} prices against the page again.`
        : `Check the ${n} price${n === 1 ? "" : "s"} read from the pricing page against the page itself, once: every price answer is then checked against them.`,
    href,
    fix: "Check the table",
    required: true,
  };
}

const asRead = (r: PriceRow): NonNullable<PriceRow["readAs"]> => ({
  plan: r.plan,
  amount: r.amount,
  value: r.value,
  ...(r.currency && { currency: r.currency }),
  ...(r.period && { period: r.period }),
});

// The table with one row corrected by hand: its amount ("$4,500", "4.500 €") and, when given, its
// unit and period. The hash changes with it. An amount that isn't a price is an error.
export function editPriceRow(
  table: PriceTable,
  index: number,
  edit: { amount: string; unit?: string; period?: string; plan?: string; addOn?: boolean; note?: string },
): { table: PriceTable; plan: string } | { error: string } {
  const row = table.rows[index];
  if (!row) return { error: "That row is no longer in the table: reload the page." };
  const amount = edit.amount.trim().slice(0, 40);
  const read = priceAmounts(amount)[0] ?? priceAmounts(`${row.currency ?? "$"} ${amount}`)[0];
  // $0 is a price: a free plan is a row (round 7).
  if (!read || !(read.value >= 0)) return { error: `Type ${row.plan}'s price as the page shows it, for example ${row.amount}.` };
  const period = edit.period === "month" || edit.period === "year" || edit.period === "once" ? edit.period : undefined;
  const unit = edit.unit?.trim().slice(0, 40);
  const plan = edit.plan === undefined ? row.plan : edit.plan.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!plan) return { error: "Type the plan's name as the page shows it." };
  // A person has looked at this row: any doubt about it is answered.
  const { addOn: wasAddOn, doubt: _answered, doubtAccepted: _accepted, ...rest } = row;
  const addOn = edit.addOn === undefined ? wasAddOn : edit.addOn;
  const next: PriceRow = {
    ...rest,
    // What the page's reading gave, the first time a person changes it.
    ...(!row.readAs && row.line !== "Added by hand" && { readAs: asRead(row) }),
    plan,
    amount,
    value: read.value,
    ...(unit !== undefined && (unit ? { unit } : { unit: undefined })),
    ...(edit.period !== undefined && { period }),
    ...(addOn && { addOn: true }),
    // What the person typed replaces the reader's qualifiers: what tells this price from another.
    ...(edit.note !== undefined && { qualifiers: edit.note.trim() ? [edit.note.trim().slice(0, 60)] : undefined }),
  };
  const rows = table.rows.map((r, i) => (i === index ? next : r));
  return { table: withRows(table, rows), plan };
}

// A table with a person's rows: the note on figures no row has names only those still without one.
function withRows(table: PriceTable, rows: PriceRow[]): PriceTable {
  const { unplaced: _old, ...rest } = table;
  const unplaced = stillUnplaced(rows, table.unplaced);
  return { ...rest, rows, hash: priceRowsHash(rows), ...(unplaced.length && { unplaced }) };
}

// A row the page has and the table doesn't (an add-on, a yearly price), typed by a person.
export function addPriceRow(
  table: PriceTable,
  add: { plan: string; amount: string; unit?: string; period?: string; addOn?: boolean; note?: string },
): { table: PriceTable; plan: string } | { error: string } {
  const plan = add.plan.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!plan) return { error: "Type the plan's name as the page shows it." };
  const amount = add.amount.trim().slice(0, 40);
  const sign = table.rows[0]?.amount.replace(/[\d.,\s]/g, "") || "$";
  const read = priceAmounts(amount)[0] ?? priceAmounts(`${sign} ${amount}`)[0];
  if (!read || !(read.value >= 0))
    return { error: `Type ${plan}'s price as the page shows it, for example ${table.rows[0]?.amount ?? "$49"}.` };
  const period = add.period === "month" || add.period === "year" || add.period === "once" ? add.period : undefined;
  const unit = add.unit?.trim().slice(0, 40);
  const url = table.pages[0] ?? table.rows[0]?.url;
  if (!url) return { error: "This table has no pricing page to add a row to." };
  const currency = table.rows[0]?.currency;
  const row: PriceRow = {
    plan,
    amount,
    value: read.value,
    ...(currency && { currency }),
    ...(unit && { unit }),
    ...(period && { period }),
    url,
    line: "Added by hand",
    ...(add.addOn && { addOn: true }),
    ...(add.note?.trim() && { qualifiers: [add.note.trim().slice(0, 60)] }),
  };
  const rows = [...table.rows, row];
  return { table: withRows(table, rows), plan };
}

// A row that isn't a price of this site's (a badge, a feature line). The last row can't go: a table
// with no rows has nothing to check answers against.
export function deletePriceRow(table: PriceTable, index: number): { table: PriceTable; plan: string } | { error: string } {
  const row = table.rows[index];
  if (!row) return { error: "That row is no longer in the table: reload the page." };
  if (table.rows.length === 1) return { error: "That's the table's only row: correct it instead." };
  const rows = table.rows.filter((_, i) => i !== index);
  // A later reading of the same page doesn't bring it back, and isn't a change.
  const removed = row.line === "Added by hand" ? [] : [row.readAs ?? asRead(row)];
  return {
    table: {
      ...table,
      rows,
      hash: priceRowsHash(rows),
      ...(removed.length && { removedByHand: [...(table.removedByHand ?? []), ...removed] }),
    },
    plan: row.plan,
  };
}

// A confirmation from the signed-in person, or, in setup mode (one shared password), the name
// they typed, marked as not verified.
export function confirmationBy(user: ConsoleUser, typedName: string | undefined, at = new Date()): Confirmation | { error: string } {
  if (!user.setupMode) return { by: user.id, name: user.name, at: at.toISOString(), verified: true };
  const name = (typedName ?? "").trim().slice(0, 80);
  if (!name) return { error: "Type your name: setup mode can't tell who you are." };
  return { by: null, name: `${name} (setup mode, not verified)`, at: at.toISOString(), verified: false };
}
