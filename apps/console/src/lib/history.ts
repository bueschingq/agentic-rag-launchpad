// A deployment's history from the audit log, in words: who signed it off, skipped a part on
// purpose, changed what visitors see, paused it, and so on. Every entry the console writes for
// the deployment shows; an action without words of its own shows as its name.

import { auditLog, users } from "@launchpad/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.ts";

export const WORDS: Record<string, string> = {
  "deployment.create": "created the deployment",
  "deployment.provision": "provisioned the Knowledge Box",
  "deployment.scan": "scanned the site",
  "deployment.widget": "changed the widget",
  "deployment.confirm": "confirmed the brand",
  "deployment.starters": "chose the starter questions",
  "deployment.starters.suggested": "asked for starter suggestions",
  "deployment.starters.removed": "took a starter that stopped answering off the chat",
  "deployment.prompt": "changed how it answers",
  "deployment.validate": "ran validation",
  "deployment.validation.acknowledge": "checked an answer against the site",
  "deployment.validation.add-pages": "added pages for a question with no answer",
  "deployment.validation.ask-again": "asked a question again",
  "deployment.validation.not-covered": "marked a question as not covered by the site",
  "deployment.skip": "left a part out on purpose",
  "deployment.signoff": "signed it off",
  "deployment.domains": "changed the domains",
  "deployment.leads": "changed where leads go",
  "deployment.pause": "paused it",
  "deployment.resume": "resumed it",
  "deployment.reveal-writer-key": "revealed the writer key",
  "deployment.install-check": "found the snippet with Check installation",
  "deployment.up-to-date": "kept the prompt while bringing it up to date",
  "deployment.rules.applied": "applied the answering rules",
  "deployment.rules.held": "kept the older answering rules: newer ones would make answers worse",
  "deployment.rules.tried": "couldn't re-check the newer answering rules yet: it tries again later",
  "deployment.price-table.read": "read the price table from the pricing pages",
  "deployment.price-table.confirm": "confirmed the price table matches the pricing page",
  "deployment.price-table.edit": "corrected a row of the price table",
  "deployment.price-table.add": "added a row to the price table",
  "deployment.price-table.delete": "removed a row from the price table",
  "deployment.uptodate": "brought it up to date overnight",
  "deployment.augment": "set up Agentic RAG's agents to improve answers",
  "deployment.augment-off": "removed Agentic RAG's answer agents",
  "content.plan": "set the content plan",
  "content.settings": "changed the content settings",
  "content.sync": "started a sync",
  "content.retry": "retried failed pages",
  "content.exclude": "left a page out",
  "content.up-to-date": "applied today's content rules",
  "content.pin": "added pages by hand",
  "content.key-pages": "added the site's key pages to the sync",
  "content.reread": "had the pages read again",
  "content.retracted": "took pages left out by hand out of the chat",
  "customer.update": "changed the customer",
  "share.install": "shared the install guide",
  "share.report": "shared the client report",
  "share.revoke": "revoked a share link",
};

export interface HistoryEntry {
  at: Date;
  who: string;
  what: string;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const path = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
const quoted = (q: unknown) => (typeof q === "string" && q.trim() ? `: “${q.trim()}”` : "");
const AUTO_RUN: Record<string, string> = {
  "sync-finished": "after the first sync",
  "half-answerable": "once half the pages were answerable",
  "pages-added": "with the pages added",
};

// Pages added by hand (Always include, Add these pages) and kept despite a date or stale-price
// rule (Keep it anyway): what was added, what was kept and why, or that a rule asked first.
function pinWords(detail: Record<string, unknown>): string {
  const added = strings(detail.added);
  const kept = Array.isArray(detail.kept) ? (detail.kept as { url?: unknown; rule?: unknown; reason?: unknown }[]) : [];
  const asked = Array.isArray(detail.needsReason) ? detail.needsReason.length : 0;
  if (kept.length) {
    const stale = kept.some((k) => typeof k.rule === "string" && /\bstates (a price|a discount or offer|a version)\b/.test(k.rule));
    const reason = kept.find((k) => typeof k.reason === "string")?.reason as string | undefined;
    return `kept ${kept.length === 1 && typeof kept[0]?.url === "string" ? path(kept[0].url) : pages(kept.length)} by hand despite ${
      stale ? "a stale price" : "its date"
    }${reason ? `: “${reason.trim()}”` : ""}`;
  }
  if (added.length) return `added ${added.length <= 3 ? added.map(path).join(", ") : pages(added.length)} by hand`;
  if (asked) return `tried to add ${pages(asked)} by hand: a date or stale-price rule asks for a reason first`;
  return WORDS["content.pin"]!;
}

// What an entry says in words: its action's words, and what the entry adds (the person named in
// a sign-off or skip, the part skipped, the validation result, the question, the page).
export function historyWhat(action: string, detail: Record<string, unknown>): string {
  if (action === "content.pin") return pinWords(detail);
  // A hold the daily re-check found again (jobs/rules-rollout.ts): not a second alert.
  if (action === "deployment.rules.held" && detail.repeat === true)
    return "re-checked the newer answering rules: still worse, so it keeps the older ones";
  const words = WORDS[action] ?? action.split(".").at(-1)!.replace(/-/g, " ");
  return `${words}${more(action, detail)}`;
}

function more(action: string, detail: Record<string, unknown>): string {
  switch (action) {
    case "deployment.skip":
      return typeof detail.consequence === "string" ? `: ${detail.consequence}` : detail.undone ? ", then undid it" : "";
    case "deployment.validate": {
      const when = typeof detail.auto === "string" && AUTO_RUN[detail.auto] ? ` ${AUTO_RUN[detail.auto]}` : "";
      return `${when}${typeof detail.passed === "boolean" ? (detail.passed ? ": passed" : ": didn't pass") : ""}`;
    }
    case "deployment.signoff":
      return detail.replaces ? ", for the changes since the last sign-off" : detail.previousChecksVersion ? ", under today's checks" : "";
    case "deployment.starters.removed":
      return `${quoted(detail.question)}${typeof detail.reason === "string" ? ` (${detail.reason})` : ""}`;
    case "deployment.validation.acknowledge":
    case "deployment.validation.not-covered":
      return quoted(detail.question);
    case "deployment.validation.add-pages":
      return `${quoted(detail.question)}${typeof detail.kept === "string" ? `, kept anyway: “${detail.kept}”` : ""}`;
    case "deployment.validation.ask-again": {
      const when = typeof detail.auto === "string" && AUTO_RUN[detail.auto] ? ` ${AUTO_RUN[detail.auto]}` : "";
      const result = typeof detail.answered === "boolean" ? (detail.answered ? ", answered" : ", still no answer") : "";
      return `${when}${quoted(detail.question)}${result}`;
    }
    case "content.exclude":
      return typeof detail.url === "string" ? `: ${detail.url}` : "";
    case "content.key-pages": {
      // What Add's sync changed, once the worker has settled the entry (its preview kept as
      // proposed); until then, what Add proposed (round 5: History read "13 pages join" while
      // not one key page had joined).
      const [added, joined, dropped] = [strings(detail.added).length, strings(detail.joined).length, strings(detail.dropped).length];
      const keyPages = (n: number) => `${n} key ${n === 1 ? "page" : "pages"}`;
      if (detail.settled && detail.proposed) {
        return `: ${added ? `${keyPages(added)} joined` : "no key page joined"}${joined ? `, with ${pages(joined)} more` : ""}${
          dropped ? `; ${pages(dropped)} at the end of the budget left` : ""
        }`;
      }
      if (!added && !joined && !dropped) return "";
      if (!detail.settled && "before" in detail) {
        return `: ${keyPages(added)} to join${joined ? ` with ${pages(joined)} more` : ""}${
          dropped ? `, ${pages(dropped)} at the end of the budget to leave` : ""
        } once the sync finishes`;
      }
      // An entry from before Add's outcome was recorded: what it proposed.
      return `: ${pages(added + joined)} join${added + joined === 1 ? "s" : ""}${
        dropped ? `, ${pages(dropped)} at the end of the budget leave${dropped === 1 ? "s" : ""}` : ""
      }`;
    }
    case "deployment.rules.applied": {
      // "applied the answering rules v1 after a re-check: 14 of 14 unchanged or better"
      const r = detail.recheck as { total?: unknown; unchanged?: unknown; better?: unknown } | undefined;
      const num = (v: unknown) => (typeof v === "number" ? v : 0);
      const version = typeof detail.to === "number" ? ` v${detail.to}` : "";
      return `${version}${r && typeof r.total === "number" ? ` after a re-check: ${num(r.unchanged) + num(r.better)} of ${r.total} unchanged or better` : ""}`;
    }
    case "deployment.uptodate": {
      // The overnight bring-up-to-date (jobs/rules-rollout.ts), by step.
      const step: Record<string, string> = {
        reread: ": read its pages again",
        unfinished: ": stopped waiting for pages that didn't finish reading",
        applied: ": applied after a re-check",
        held: ": held, as answers would get worse",
        tried: ": couldn't re-check yet, and tries again later",
      };
      return typeof detail.step === "string" ? (step[detail.step] ?? "") : "";
    }
    case "content.reread": {
      const n = typeof detail.pages === "number" ? detail.pages : undefined;
      return `${detail.tonight ? " in tonight's batch, from Fleet" : ""}${n !== undefined ? ` (${pages(n)})` : ""}`;
    }
    case "content.retracted": {
      const taken = strings(detail.pages);
      return taken.length ? `: ${taken.length <= 3 ? taken.map(path).join(", ") : pages(taken.length)}` : "";
    }
    case "deployment.install-check":
      return typeof detail.url === "string" ? ` on ${detail.url}` : "";
    default:
      return "";
  }
}

// One answering-rules change since a sign-off, for Review's "changes since sign-off" (round 6,
// item 7): "answering rules v4 → v5, applied after a re-check", or "…, switched by Dana" when a
// person switched after a hold (the name typed in setup mode; Review names the signed-in person
// itself), else "…, applied". Undefined for an entry with no versions.
export function rulesChangeLine(detail: unknown, by?: string | null): string | undefined {
  const d = (detail ?? {}) as { from?: unknown; to?: unknown; recheck?: unknown; name?: unknown };
  if (typeof d.to !== "number") return undefined;
  const from = typeof d.from === "number" ? `v${d.from} → ` : "";
  const name = by?.trim() || (typeof d.name === "string" && d.name.trim() ? notVerified(d.name) : "");
  return `answering rules ${from}v${d.to}, ${d.recheck ? "applied after a re-check" : name ? `switched by ${name}` : "applied"}`;
}

// A name typed in setup mode, marked "(not verified)" once: some entries store it already marked
// ("Dana (setup mode, not verified)").
export const notVerified = (name: string) => (/not verified/.test(name) ? name.trim() : `${name.trim()} (not verified)`);

// Setup mode can't tell who is at the keyboard, so a typed name stands for the person for one
// sitting: an entry that recorded no name takes the name typed nearest to it on the deployment,
// before or after, within two hours. Never a name from another day (round 5: Review credited the
// UX designer's changes to the round-4 signer), and a step taken just before the name was typed
// still gets it (the SE's "Read the pages again", minutes before he typed his name for Add,
// read "Someone in setup mode"). Pure.
export const SITTING_MS = 2 * 3_600_000;
export function typedNear(typed: readonly { at: Date; name: string | null }[], at: Date): string | undefined {
  let best: { gap: number; name: string } | undefined;
  for (const t of typed) {
    const name = t.name?.trim();
    const gap = Math.abs(t.at.getTime() - at.getTime());
    if (name && gap <= SITTING_MS && (!best || gap < best.gap)) best = { gap, name };
  }
  return best?.name;
}

// Who did it: a signed-in person by name; the worker's own runs as the automatic re-run; in setup
// mode, the name typed with the decision, marked "(not verified)" once; for a setup-mode entry that
// recorded no name, the name typed in the same sitting (typedNear), marked the same way. The name
// in a deployment's create entry is the deployment's, not a person's.
export function historyActor(action: string, detail: Record<string, unknown>, user: string | null, sitting?: string): string {
  if (user) return user;
  if (detail.auto === "upgrade") return "The upgrade";
  if (detail.auto) return "The automatic re-run";
  // The worker's rules rollout, after its re-check: nobody typed anything.
  if (action === "deployment.rules.applied" && detail.recheck && typeof detail.name !== "string") return "The automatic re-check";
  if (action === "deployment.rules.held") return "The automatic re-check";
  if (detail.via === "share") return "Someone with the install guide link";
  // Create entries' `name` is the deployment's; the session's typed name is `typedBy` there
  // (lib/setup-name.ts).
  const own = action === "deployment.create" || action === "customer.create" ? detail.typedBy : detail.name;
  const typed = typeof own === "string" ? own.trim() : "";
  if (typed) return notVerified(typed);
  return sitting?.trim() ? notVerified(sitting) : "Someone in setup mode";
}

// The names typed in setup mode on a deployment, oldest first: for typedNear, here and on Review
// and Bring up to date, wherever a setup-mode line recorded no name.
export function typedNames(deploymentId: string): Promise<{ at: Date; name: string }[]> {
  return db()
    .select({ at: auditLog.at, name: sql<string>`${auditLog.detail}->>'name'` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetId, deploymentId),
        isNull(auditLog.actorUserId),
        sql`${auditLog.detail}->>'verified' = 'false'`,
        sql`${auditLog.detail}->>'auto' is null`,
        sql`coalesce(${auditLog.detail}->>'name', '') <> ''`,
      ),
    )
    .orderBy(asc(auditLog.at));
}

export async function loadHistory(deploymentId: string, limit = 40): Promise<HistoryEntry[]> {
  const [rows, typed] = await Promise.all([
    db()
      .select({ action: auditLog.action, at: auditLog.at, detail: auditLog.detail, name: users.name, email: users.email })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(eq(auditLog.targetId, deploymentId))
      .orderBy(desc(auditLog.at))
      .limit(limit),
    typedNames(deploymentId),
  ]);
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const sitting = (r.name ?? r.email) ? undefined : typedNear(typed, r.at);
    return { at: r.at, who: historyActor(r.action, detail, r.name ?? r.email, sitting), what: historyWhat(r.action, detail) };
  });
}
