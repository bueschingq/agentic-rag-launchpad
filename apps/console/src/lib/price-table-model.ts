// The price table, proposed by a model and proved by code (fix cycle 7c). Round 7's pattern reading
// passed on the pages it was built against and failed on each new site ("Basic is", "Extra emails @",
// "Preis"), so reading a page's prices is the model's job, and believing it is code's.
//
// After a sync (apps/worker/src/jobs/content.ts refreshPriceTable, never the chat's path), each
// pricing page's stored text goes to the model through the same route as the answer judge
// (lib/judge.ts: /predict/chat with the account's NUA key). It proposes rows: plan, amount, unit,
// period, qualifiers such as a volume or seats, add-on or not.
//
// A row is accepted only if code finds its figure on that page and its plan's name there too; the
// figure kept is the page's own writing and the line it's on is recorded. A row that fails is
// rejected and listed, never repaired. A period, unit or qualifier the page doesn't state beside the
// figure is dropped: nothing is worked out or normalized. A figure sitting nearer another plan's name
// stays, with a doubt the person reads on the card (priceDoubts in lib/price-table.ts adds the
// plausibility checks).
//
// Each page's proposal is cached in the table by the page's text, so reading unchanged pages again
// costs nothing. When the call fails, that page is read by the patterns (lib/price-table.ts), and
// PriceTable.builtBy says so. Worker-importable: no page code.

import { createHash } from "node:crypto";
import type { PageFacts, PriceRow, PriceTable } from "@launchpad/db";
import { nuaZone, predictChat } from "@launchpad/par-client";
import { figuresOnLine, figureValue } from "./content-plan.ts";
import { env } from "./env.ts";
import { currencyOf, type ModelPage, type ModelRead, periodOf } from "./price-table.ts";

// Bumped whenever the prompt or the proof changes: pages are then proposed again.
export const PRICE_MODEL_VERSION = 1;
// One page's call at most this long: a sync's end doesn't wait on a stuck one.
const TIMEOUT_MS = 45_000;
const MAX_TOKENS = 2500;
// A page's text the model reads, at most (about 3,500 tokens). A longer page keeps its figures and
// what surrounds them.
const MAX_PAGE_TEXT = 14_000;
// Pages read per deployment, at most: the cost's bound. Regional copies repeat the same table.
export const MAX_MODEL_PAGES = 4;
// How many lines above a figure its plan's name may be before the row is doubted.
const NEAR_LINES = 20;

export type ProposedRow = NonNullable<NonNullable<PriceTable["modelRead"]>["pages"][string]>["rows"][number];

// The text the model reads: the whole page when it fits, else the headings, the lines with a figure
// and a few lines around them. Pure.
export function pageTextForModel(text: string, max = MAX_PAGE_TEXT): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (/^\s*#{1,6}\s/.test(line)) keep.add(i);
    if (figuresOnLine(line).length) for (let n = Math.max(0, i - 4); n <= Math.min(lines.length - 1, i + 3); n++) keep.add(n);
  });
  const kept = lines.filter((line, i) => keep.has(i) && line.trim()).join("\n");
  return kept.slice(0, max);
}

// The instruction, with the page. Pure.
export function pricePrompt(page: { url: string; title?: string | null; text: string }): string {
  return [
    "You read one page of a company's website and list the prices it states for what the company sells. Reply with JSON only:",
    '{"rows":[{"plan":"","amount":"","unit":null,"period":null,"qualifiers":[],"addOn":false}]}',
    "One row for each price stated: each plan, each add-on, each billing cycle and each volume or size the page prices.",
    '"plan": the name of the plan or product exactly as the page writes it, in the page\'s language. A name, never a sentence, a heading about prices, a badge or a feature.',
    '"amount": the figure exactly as the page writes it, with its currency. Copy it: never calculate, convert or round. A price the page does not state gets no row. A plan priced by quote or "contact us" gets no row.',
    '"unit": what the figure is per, in the page\'s words, when it says ("per user", "per node", "per 1,000 emails", "per GB"). Else null.',
    '"period": "month", "year" or "once", only when the page states it for this figure. A monthly price billed yearly has period "month" and the qualifier "billed annually". Else null.',
    '"qualifiers": short phrases copied from the page that say when this price applies: the volume or size it is for ("50,000 emails"), seats, "starting at", "billed annually", "billed monthly". A page with a selector shows the prices for its selected value: give that value as a qualifier.',
    '"addOn": true for something bought on top of a plan. An overage rate belongs to its plan and is an add-on, not the plan\'s price: plan "Basic", unit "per 1,000 extra emails", addOn true.',
    "A section headed like 'Prices with \"MONTHLY\" selected' holds what the page shows under that setting: those are real prices of the same plans, and that setting is the period or the product line they belong to.",
    'When such a section\'s prices carry names of their own ("24x7 Live Support"), the plan is that name: never carry a name over from another section.',
    "Go through every figure on the page, tables and headings included (\"Basic$10/user/mo\" in a table's header is Basic's price).",
    'No rows for: what a figure would otherwise cost ("instead of $240"), a worked example ("for example, Basic is $90"), discounts, credits, savings, what a competitor charges, a customer\'s figure, a shipping cost.',
    "If the page states no price for anything sold, reply with no rows.",
    `Page: ${page.title ? `${page.title} ` : ""}(${page.url})`,
    `Text:\n${pageTextForModel(page.text)}`,
  ].join("\n");
}

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

// One row from the model's reply, in shape, or undefined.
function shaped(row: unknown): ProposedRow | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const plan = text(r.plan);
  const amount = text(r.amount);
  if (!plan || !amount) return undefined;
  const unit = text(r.unit);
  const period = text(r.period).toLowerCase();
  const qualifiers = Array.isArray(r.qualifiers) ? r.qualifiers.map(text).filter(Boolean).slice(0, 6) : [];
  return {
    plan: plan.slice(0, 80),
    amount: amount.slice(0, 40),
    ...(unit && unit.toLowerCase() !== "null" && { unit: unit.slice(0, 40) }),
    ...((period === "month" || period === "year" || period === "once") && { period }),
    ...(qualifiers.length && { qualifiers }),
    ...(r.addOn === true && { addOn: true }),
  };
}

// The model's rows from its reply, or undefined when it isn't such a reply. A reply cut off by the
// length limit gives the rows before the cut. Pure.
export function parseProposal(reply: string): ProposedRow[] | undefined {
  const start = reply.indexOf("{");
  if (start < 0) return undefined;
  const json = reply.slice(start);
  const read = (candidate: string): ProposedRow[] | undefined => {
    try {
      const parsed = JSON.parse(candidate) as { rows?: unknown };
      return Array.isArray(parsed.rows) ? parsed.rows.flatMap((r) => shaped(r) ?? []) : undefined;
    } catch {
      return undefined;
    }
  };
  const end = json.lastIndexOf("}");
  if (end < 0) return undefined;
  const whole = read(json.slice(0, end + 1));
  if (whole) return whole;
  return json.includes('"rows"') ? read(`${json.slice(0, end + 1)}]}`) : undefined;
}

const squash = (line: string) => line.replace(/\s+/g, " ").trim();
const named = (name: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}])`, "iu");
const cleanLine = (line: string) =>
  squash(
    line
      .replace(/^\s*(?:#{1,6}|[-*+>])\s+/, "")
      .replace(/\*\*|`/g, "")
      .replace(/\s*\|\s*/g, " · ")
      .replace(/^·\s*|\s*·$/g, ""),
  );
// A line that names something by itself: a heading, or a label before a colon.
const isTitleLine = (line: string, name: RegExp) => {
  if (!name.test(line)) return false;
  const bare = cleanLine(line);
  return (
    /^\s*#{1,6}\s/.test(line) ||
    bare.replace(name, "").replace(/\W+/gu, "").length <= 2 ||
    new RegExp(`^${name.source}\\s*:`, "iu").test(bare)
  );
};

export interface Rejected {
  plan: string;
  amount: string;
  url: string;
  why: string;
}

// The proof. Each proposed row against the page's stored text. Pure.
export function proveRows(
  proposed: readonly ProposedRow[],
  page: { url: string; text: string },
): { rows: PriceRow[]; rejected: Rejected[] } {
  const lines = page.text.split("\n");
  const pageWords = page.text.toLowerCase();
  const figures = lines.flatMap((line, i) =>
    figuresOnLine(line).map((f) => ({ i, raw: squash(f.raw), at: f.at, value: Number(figureValue(f.raw)), currency: currencyOf(f.raw) })),
  );
  const rows: PriceRow[] = [];
  const rejected: Rejected[] = [];
  const planNames = [...new Set(proposed.map((p) => p.plan))];
  for (const p of proposed) {
    const reject = (why: string) => rejected.push({ plan: p.plan, amount: p.amount, url: page.url, why });
    const wanted = Number(figureValue(p.amount));
    if (!/\d/.test(p.amount) || !Number.isFinite(wanted)) {
      reject("It isn't a figure.");
      continue;
    }
    const currency = currencyOf(p.amount);
    const same = figures.filter((f) => f.value === wanted && (!currency || !f.currency || f.currency === currency));
    if (!same.length) {
      reject(`The page doesn't state ${p.amount}.`);
      continue;
    }
    // A name the model gave with a note in brackets is the name without it, if that's what the page has.
    const base = p.plan.replace(/\s*\([^)]*\)\s*$/, "");
    const plan = named(p.plan).test(page.text) ? p.plan : base && named(base).test(page.text) ? base : undefined;
    if (!plan) {
      reject(`The page doesn't name "${p.plan}".`);
      continue;
    }
    const mine = named(plan);
    const others = planNames
      .filter((n) => n !== p.plan && n !== plan && !mine.test(n) && !named(n).test(plan))
      .map((n) => ({ n, re: named(n) }));
    // The figure's place on the page nearest the plan's name. On its own line, the name before the
    // figure counts (a sentence may name two plans); above it, the name above any other plan's.
    const placed = same.map((f) => {
      const line = lines[f.i]!;
      const before = line.slice(0, f.at);
      const lastAt = (re: RegExp) => {
        const all = [...before.matchAll(new RegExp(re.source, "giu"))];
        return all.length ? all.at(-1)!.index! : -1;
      };
      const ownAt = lastAt(mine);
      const nearer = others.find((o) => lastAt(o.re) > ownAt);
      if (ownAt >= 0 && !nearer) return { f, distance: 0, nearer: undefined, nameLine: f.i };
      if (nearer) return { f, distance: 1000, nearer: nearer.n, nameLine: f.i };
      if (mine.test(line)) return { f, distance: 1, nearer: undefined, nameLine: f.i };
      for (let i = f.i - 1; i >= 0 && f.i - i <= 60; i--) {
        if (mine.test(lines[i]!)) return { f, distance: f.i - i, nearer: undefined, nameLine: i };
        const other = others.find((o) => isTitleLine(lines[i]!, o.re));
        if (other) {
          // The plan's name may come just after its price.
          const below = lines.slice(f.i + 1, f.i + 4).findIndex((l) => mine.test(l));
          return below >= 0
            ? { f, distance: below + 2, nearer: undefined, nameLine: f.i + 1 + below }
            : { f, distance: 1000, nearer: other.n, nameLine: i };
        }
      }
      const below = lines.slice(f.i + 1, f.i + 4).findIndex((l) => mine.test(l));
      return below >= 0
        ? { f, distance: below + 2, nearer: undefined, nameLine: f.i + 1 + below }
        : { f, distance: 999, nearer: undefined, nameLine: -1 };
    });
    const best = placed.sort((a, b) => a.distance - b.distance)[0]!;
    const at = best.f.i;
    // What's stated beside the figure: its line, the lines around it, the section it's under.
    const near = lines.slice(Math.max(0, at - 2), at + 3).join(" ");
    const section = [...lines.slice(0, at)].reverse().find((l) => /^##\s+Prices with /.test(l)) ?? "";
    const beside = `${near} ${section}`;
    const period =
      p.period && periodOf(beside) === p.period ? p.period : p.period && periodStatedAs(beside, p.period) ? p.period : undefined;
    const unitWord =
      p.unit
        ?.toLowerCase()
        .split(/[^\p{L}\p{N},]+/u)
        .filter((w) => w.length > 1 && !/^(?:per|pro|por|par)$/.test(w)) ?? [];
    const unit = p.unit && unitWord.length && unitWord.every((w) => near.toLowerCase().includes(w.replace(/s$/, ""))) ? p.unit : undefined;
    // A qualifier's words are all on the page, its numbers above all.
    const qualifiers = (p.qualifiers ?? []).filter((q) =>
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N},.]+/u)
        .filter((w) => w.length > 2)
        .every((w) => pageWords.includes(w)),
    );
    const line = cleanLine(lines[at]!);
    const nameLine = best.nameLine >= 0 && best.nameLine !== at ? cleanLine(lines[best.nameLine]!) : undefined;
    const doubt = best.nearer
      ? `On the page, ${best.f.raw} sits nearer "${best.nearer}" than "${plan}".`
      : best.distance > NEAR_LINES
        ? `On the page, ${best.f.raw} is far from the name "${plan}".`
        : undefined;
    const row: PriceRow = {
      plan,
      amount: best.f.raw,
      value: wanted,
      ...(best.f.currency && { currency: best.f.currency }),
      ...(unit && { unit }),
      ...(period && { period }),
      ...(qualifiers.length && { qualifiers }),
      url: page.url,
      line: (nameLine ? `${nameLine}: ${line}` : line).slice(0, 240),
      ...(p.addOn && { addOn: true }),
      ...(doubt && { doubt }),
    };
    // The same figure on the same terms, said twice (a table's header and a sentence), is one row
    // with what both say. A volume or a seat count that differs keeps them apart.
    const twin = rows.find(
      (o) =>
        o.plan.toLowerCase() === row.plan.toLowerCase() && o.value === row.value && o.currency === row.currency && o.period === row.period,
    );
    if (!twin) rows.push(row);
    else {
      const merged = [...new Set([...(twin.qualifiers ?? []), ...(row.qualifiers ?? [])])];
      if (merged.length) twin.qualifiers = merged;
      if (!twin.unit && row.unit) twin.unit = row.unit;
    }
  }
  return { rows, rejected };
}

// Whether the text states this period, even with another mentioned: "per month, billed annually".
function periodStatedAs(beside: string, period: "month" | "year" | "once"): boolean {
  const without = (re: RegExp) => periodOf(beside.replace(re, " "));
  return period === "month"
    ? without(/\b(?:per|a|\/)\s*(?:year|yr|jahr|año)\b|\b(?:annually|yearly|jährlich|anual\p{L}*|annuel\p{L}*|billed annually)\b/giu) ===
        "month"
    : period === "year"
      ? without(/\b(?:per|a|\/)\s*(?:month|mo|monat|mes|mois)\b|\b(?:monthly|monatlich|mensual\p{L}*|mensuel\p{L}*)\b/giu) === "year"
      : false;
}

export const pageTextHash = (text: string) => createHash("sha256").update(`${PRICE_MODEL_VERSION}\n${text}`).digest("hex").slice(0, 32);

// The model's call. Undefined when it couldn't be asked or its reply can't be read. Never throws.
export async function askModelForPrices(
  page: { url: string; title?: string | null; text: string },
  call: typeof predictChat = predictChat,
): Promise<{ rows?: ProposedRow[]; error?: string; ms: number; model?: string }> {
  const started = Date.now();
  try {
    const nuaKey = env().nuaKey;
    const zone = nuaZone(nuaKey);
    if (!zone) return { error: "The account key names no zone.", ms: 0 };
    const result = await call({
      zone,
      nuaKey,
      body: { question: pricePrompt(page), user_id: "launchpad-price-table", temperature: 0, max_tokens: MAX_TOKENS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rows = parseProposal(result.text);
    return rows
      ? { rows, ms: Date.now() - started, ...(result.model && { model: result.model }) }
      : { error: "The model's reply couldn't be read.", ms: Date.now() - started };
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? `no reply within ${TIMEOUT_MS / 1000} s` : String(err);
    return { error: `The model couldn't be asked: ${why}`.slice(0, 200), ms: Date.now() - started };
  }
}

// Whether a page is worth a call: it states a figure.
const statesFigure = (page: { text: string; facts?: PageFacts | null }) =>
  Boolean(page.facts?.prices?.length) || page.text.split("\n").some((l) => figuresOnLine(l).length > 0);

// The reader lib/price-table.ts priceTableFor takes after a sync: each page (in the table's order, at
// most MAX_MODEL_PAGES that state a figure) proposed once per text, and proved. `ask` is the model's
// call, a parameter so tests never reach it.
export function modelPriceReader(
  ask: typeof askModelForPrices = askModelForPrices,
): (pages: readonly ModelPage[], cache: PriceTable["modelRead"]) => Promise<ModelRead> {
  return async (pages, cache) => {
    const usable = pages.filter((p) => p.text && statesFigure({ text: p.text, facts: p.facts })).slice(0, MAX_MODEL_PAGES);
    const kept: NonNullable<PriceTable["modelRead"]>["pages"] = {};
    const old = cache?.version === PRICE_MODEL_VERSION ? cache.pages : {};
    const rows: PriceRow[] = [];
    const rejected: Rejected[] = [];
    const failed: string[] = [];
    const read: string[] = [];
    let calls = 0;
    let error: string | undefined;
    for (const page of usable) {
      const key = `${page.url} ${pageTextHash(page.text!)}`;
      let proposed = old[key]?.rows;
      if (!proposed) {
        calls += 1;
        const asked = await ask({ url: page.url, title: page.title ?? null, text: page.text! });
        if (!asked.rows) {
          failed.push(page.url);
          error = asked.error;
          continue;
        }
        proposed = asked.rows;
      }
      kept[key] = { rows: proposed };
      read.push(page.url);
      const proved = proveRows(proposed, { url: page.url, text: page.text! });
      rejected.push(...proved.rejected);
      for (const r of proved.rows) {
        // A page repeating another's row ("/de/pricing") is one row, from the first.
        const same = (o: PriceRow) =>
          o.plan.toLowerCase() === r.plan.toLowerCase() && o.value === r.value && o.currency === r.currency && o.period === r.period;
        if (!rows.some(same)) rows.push(r);
      }
    }
    return { rows, rejected, read, failed, calls, cache: { version: PRICE_MODEL_VERSION, pages: kept }, ...(error && { error }) };
  };
}
