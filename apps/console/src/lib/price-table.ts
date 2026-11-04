// The deployment's price table (round 6, item 1): each plan's price as its pricing pages state it,
// read from what the sync stored about those pages (content_pages.facts: each figure with its line,
// "Business: $ 59 per node, per year"). Every row keeps the page and the line it came from. A
// person confirms the table once (the price-table card); answers naming a plan are then checked
// against it everywhere (checkPriceClaims in @launchpad/theme).
//
// The sync rebuilds it after each run (apps/worker/src/jobs/content.ts). Build 8: a re-read is compared
// by meaning (pageChanges): the same plans and figures leave the stored rows alone, so the table stays
// confirmed, its hand-made names stand and the chat keeps checking against it. Only a changed figure
// or plan is written, and re-opens the table naming the difference (table.changes): the new hash no
// longer matches the confirmation's, so review.ts priceTableState says "changed", Review asks again,
// and the deployment shows in Needs attention. Corrections stay on the rows that didn't change.
//
// Fix cycle 7c: after a sync the rows are proposed by a model and proved by code
// (lib/price-table-model.ts, passed in as `read`); the patterns below are the fallback when its call
// fails. Either way priceDoubts checks the rows are plausible, and a row it doubts says why.

import type { Db, PageFacts, PriceRow, PriceTable, PriceTableConfirmation } from "@launchpad/db";
import { contentPages, deployments } from "@launchpad/db";
import { planNameDoubt, priceRowsHash, rowTerms, shownQualifiers } from "@launchpad/theme";
import { and, eq, inArray } from "drizzle-orm";
import { accountBlockState } from "./ask-refusal.ts";
import { currencyOf, figureValue, isPricingPage, pageKey, pathLanguage, primaryLanguage, stillUnplaced } from "./content-plan.ts";

export { currencyOf };

import { db } from "./db.ts";

export { isPricingPage };

// ---- reading rows from a page's facts (pure) ----

const YEAR =
  /\b(?:per|a|an|each|every|pro|por|par|al|all'|\/)\s*(?:year|yr|annum|jahr|año|ano|an|anno|jaar)\b|\/\s*(?:year|yr|y)\b|\b(?:annually|yearly|jährlich|anual(?:mente)?|annuel(?:lement)?|annuale|jaarlijks)\b/i;
const MONTH =
  /\b(?:per|a|an|each|every|pro|por|par|al|\/)\s*(?:month|mo|monat|mes|mois|mese|maand)\b|\/\s*(?:month|mo|m)\b|\b(?:monthly|monatlich|mensual(?:mente)?|mensuel(?:lement)?|mensile|maandelijks)\b/i;
// "Free Lifetime Upgrades" is what a licence includes, not how often it is paid.
const ONCE = /\b(?:one[- ]time|once|perpetual|lifetime (?:licen[cs]e|access|deal|plan)|einmalig|único|unique)\b/i;
// "per node", "per user/month", "/user/month", "pro Benutzer".
const UNIT =
  /\b(?:per|pro|por|par)\s+([\p{L}][\p{L}-]{1,24})|\/\s*(user|seat|node|device|server|instance|host|endpoint|agent|license|licence|gb|tb)\b/iu;
const NOT_UNIT = /^(year|yr|annum|month|mo|jahr|monat|año|mes|mois|an|mese|maand|jaar|week|day|tag|día|jour)$/i;
// Badges and buttons the page shows by a price: not part of what it costs.
const NOISE =
  /\b(?:most popular|popular|best value|recommended|new|buy now|try (?:it )?free|free trial|get a quote|contact (?:us|sales)|learn more|get started|start (?:free )?trial|am beliebtesten|beliebt|empfohlen|jetzt kaufen|más popular|recomendado|comprar|le plus populaire|recommandé|acheter)\b/gi;
// A plan name: short, a name rather than a sentence or a heading about prices ("Pricing", "Podcast
// hosting pricing", "Plans & pricing"), nor a badge ("Recommended") or a section heading alone
// ("Subscription Add-ons").
const NOT_PLAN =
  /^(?:prices?|pricing|plans?(?: (?:and|&) pricing)?|pricing (?:and|&) plans|key features|features|faqs?|overview|cost|costs)$|(?:^|\s)(?:from|starting|ab|desde|vanaf|à partir de|a partir de)$|(?:^|\s)(?:pricing|prices|price list|plans (?:and|&) pricing|pricing plans)$/i;
const BADGE =
  /^(?:(?:most popular|popular|best value|great value|best seller|recommended|new|featured|our pick|current plan|am beliebtesten|beliebt|empfohlen|más popular|recomendado|le plus populaire|recommandé)\s*)+/i;
const BADGE_END =
  /(?:\s+(?:most popular|popular|best value|great value|best seller|recommended|new|featured|our pick|current plan|am beliebtesten|beliebt|empfohlen|más popular|recomendado|le plus populaire|recommandé))+$/i;
// A heading for add-ons: the rows under it are add-ons, named by their own line.
const ADD_ON =
  /(?<![\p{L}])(?:add-?ons?|extras?|optional|options|zusatz\p{L}*|erweiterungen|complementos?|extensiones|modules? complémentaires|opties)(?![\p{L}])/iu;
// Short words between a plan and its figure that qualify the figure: "Basic from $9", "Pro only
// $19", "Team: billed yearly: $190".
const BETWEEN =
  /(?:^|\s+)(?:from|starting (?:at|from)|starts at|as low as|only|just|now|at|billed (?:monthly|annually|yearly)|when billed (?:monthly|annually|yearly)|ab|desde|vanaf|à partir de|a partir de|da)\s*$/i;
// A figure with a currency, to find the one before this one on the line.
const ANY_FIGURE = /(?:US\$|[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)\s?\d[\d.,]*|\d[\d.,]*\s?(?:[$€£¥]|\b(?:USD|EUR|GBP|CHF)\b)(?!\s?\d)/gi;

const tidy = (text: string) =>
  text
    .replace(/\s*·\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
    .trim();

// Whether a name reads as a plan's: short, not a sentence, a price heading or a badge; digits are
// fine ("Enterprise 1", "Alfred 5 Powerpack") but not a currency.
const planLike = (plan: string, addOn: boolean) =>
  Boolean(plan) &&
  plan.split(/\s+/).length <= (addOn ? 6 : 5) &&
  /\p{L}/u.test(plan) &&
  !/[$€£¥]/.test(plan) &&
  !NOT_PLAN.test(plan) &&
  !/^(?:\S+\s+)?add-?ons?$/i.test(plan) &&
  !/[.!?"“”]$/.test(plan) &&
  !/^["“]/.test(plan);

// The period a text states (lib/price-table-model.ts's proof, and readPriceLine). Pure.
export const periodOf = (text: string): "year" | "month" | "once" | undefined =>
  YEAR.test(text) ? "year" : MONTH.test(text) ? "month" : ONCE.test(text) ? "once" : undefined;

// The trailing run of capitalised words (and digits, "+", "&") in text that may start with the
// previous figure's words ("Single User v5 License Mega Supporter" → "Mega Supporter"), at most as
// many words as the line's first plan has, when it has fewer than the run.
function trailingName(text: string, firstWords?: number): string {
  const words = tidy(text).split(" ").filter(Boolean);
  const run: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    if (/^[\p{Lu}\d(]/u.test(w) || /^[+&]$/.test(w)) run.unshift(w);
    else break;
  }
  while (run.length && /^[+&]$/.test(run[0]!)) run.shift();
  const limit = Math.min(4, firstWords && firstWords < run.length ? Math.max(1, firstWords) : 4);
  return run.slice(-limit).join(" ");
}

// One price line, read: the plan and the figure, its unit, period and qualifiers. The plan is the
// name right before the figure ("Single License £34"), else the name before a colon when only
// qualifiers stand between ("Business: starting from $ 1,229"); text before a colon that is
// followed by a name is a heading ("Buy the Alfred 5 Powerpack: Single License £34 …"), and an
// add-on heading ("Subscription Add-ons: Transcription (5 hrs per month) $5/mo") marks the row as
// an add-on. On a line with several figures, each takes the name since the one before
// ("… Mega Supporter £59"). Undefined when no plan stands before the figure (a figure in a
// sentence, a customer's quote, a bare figure no heading named). Pure.
export function readPriceLine(fact: { figure: string; line: string }, url: string): PriceRow | undefined {
  const at = fact.line.indexOf(fact.figure);
  if (at < 0) return undefined;
  const head = fact.line.slice(0, at);
  // Text since the figure before this one on the line, if any.
  const earlier = [...head.matchAll(ANY_FIGURE)];
  const prevEnd = earlier.length ? earlier.at(-1)!.index! + earlier.at(-1)![0].length : 0;
  const segment = head.slice(prevEnd);
  const parts = segment.split(":");
  let lead = parts.pop() ?? "";
  const qualifiers: string[] = [];
  const takeBetween = (text: string) => {
    let rest = text.replace(BADGE_END, "");
    for (let m = BETWEEN.exec(rest); m && rest.trim(); m = BETWEEN.exec(rest)) {
      const q = tidy(m[0]).toLowerCase();
      if (/^(?:from|starting|starts|as low as|ab|desde|vanaf|à partir de|a partir de|da)/.test(q)) qualifiers.unshift("from");
      else if (/billed/.test(q)) qualifiers.unshift(q.replace(/^when /, ""));
      rest = rest.slice(0, m.index);
    }
    return tidy(rest.replace(BADGE, "").replace(BADGE_END, ""));
  };
  let plan = takeBetween(lead);
  // Only qualifiers after the last colon: the plan is before it ("Team: billed yearly: $190").
  while (!plan && parts.length) {
    lead = parts.pop()!;
    plan = takeBetween(lead);
  }
  if (!plan) return undefined;
  // After another figure on the line, the words since it start with that figure's own.
  if (prevEnd > 0 && parts.length === 0) {
    const first = readPriceLine({ figure: earlier[0]![0], line: fact.line }, url);
    plan = trailingName(plan, first?.plan.split(/\s+/).length);
  }
  const context = parts.join(":");
  const addOn = ADD_ON.test(context) || /\(add-?on\)/i.test(plan);
  plan = plan.replace(/\s*\(add-?on\)\s*$/i, "");
  // Not a sentence, a price heading, a badge, a page title or a feature line (planNameDoubt); an
  // add-on's own line may describe it ("Transcription (5 hrs per month)").
  if (!planLike(plan, addOn) || (!addOn && planNameDoubt(plan))) return undefined;
  const value = Number(figureValue(fact.figure));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const after = fact.line.slice(at + fact.figure.length);
  // Only the words about this figure: up to another figure, a sentence's end or a quote.
  const tail = after.split(/(?=[$€£¥]\s?\d)|[.!?](?:\s|$)|[“"]/)[0] ?? "";
  const words = tail.replace(NOISE, " ");
  // The period the figure is per, before how it is billed: "$25 / month, billed annually" is a
  // monthly price paid yearly.
  const period = periodOf(words.replace(/\b(?:when |if )?billed\s+\p{L}+/giu, " ")) ?? periodOf(words);
  const unitWord = UNIT.exec(words);
  const unitName = unitWord ? (unitWord[1] ?? unitWord[2])!.toLowerCase().replace(/s$/, "") : undefined;
  const unit = unitName && !NOT_UNIT.test(unitName) ? `per ${unitName}` : undefined;
  const minimum = /\b(?:minimum|min\.?|at least|mindestens|mínimo)\s+(?:of\s+)?\d+\s+[\p{L}]+/iu.exec(words)?.[0];
  if (minimum) qualifiers.push(tidy(minimum).toLowerCase());
  const covers = /\bfor\s+(?:up to\s+)?\d[\d,.]*\s+[\p{L}]+/iu.exec(words)?.[0];
  if (covers) qualifiers.push(tidy(covers).toLowerCase());
  const billed = /\bbilled\s+(?:annually|monthly|yearly|per year|per month)\b/i.exec(words)?.[0];
  if (billed) qualifiers.push(billed.toLowerCase());
  if (/\blist price\b|\blistenpreis\b/i.test(words)) qualifiers.push("list price");
  const currency = currencyOf(fact.figure);
  return {
    plan,
    amount: fact.figure,
    value,
    ...(currency && { currency }),
    ...(unit && { unit }),
    ...(period && { period }),
    ...(qualifiers.length && { qualifiers }),
    url,
    line: fact.line,
    ...(addOn && { addOn: true }),
  };
}

// A page's rows, in the page's order: each plan's price, its unit and period taken from the other
// plans when the page states them for those only (chef.io: "Business: $ 59 per node, per year",
// then "Enterprise: $ 189"), and a plan with two prices (a monthly/annual toggle: sharefile.com's
// Premium $28.59 and $26.00) with both labelled. Pure.
export function pagePriceRows(url: string, facts: PageFacts | null | undefined): PriceRow[] {
  const rows = (facts?.prices ?? []).flatMap((p) => readPriceLine(p, url) ?? []);
  // A figure the page repeats under the same plan is one row.
  const unique = rows.filter((r, i) => rows.findIndex((o) => o.plan === r.plan && o.value === r.value) === i);
  // The unit and period the page gives, when it gives only one of each.
  const units = [...new Set(unique.flatMap((r) => (r.unit ? [r.unit] : [])))];
  const periods = [...new Set(unique.flatMap((r) => (r.period ? [r.period] : [])))];
  const byPlan = new Map<string, PriceRow[]>();
  for (const r of unique) byPlan.set(r.plan, [...(byPlan.get(r.plan) ?? []), r]);
  for (const [, own] of byPlan) {
    const unit = own.find((r) => r.unit)?.unit;
    const period = own.find((r) => r.period)?.period;
    for (const r of own) {
      const borrowed: string[] = [];
      if (!r.unit && (unit ?? (units.length === 1 ? units[0] : undefined))) {
        r.unit = unit ?? units[0];
        if (!unit) borrowed.push("unit");
      }
      if (!r.period && (period ?? (periods.length === 1 ? periods[0] : undefined))) {
        r.period = period ?? periods[0];
        if (!period) borrowed.push("period");
      }
      if (borrowed.length) r.qualifiers = [...(r.qualifiers ?? []), `${borrowed.join(" and ")} as the page states for its other plans`];
    }
    // Two prices for one plan: the page's billing toggle. The later one (where the page puts the
    // unit) is the price shown; the other is the other billing cycle's.
    if (own.length === 2) {
      const [other, shown] = own as [PriceRow, PriceRow];
      shown.qualifiers = [...(shown.qualifiers ?? []), `billing toggle: ${other.amount} on the other billing cycle`];
      other.qualifiers = [...(other.qualifiers ?? []), `billing toggle: the other billing cycle to ${shown.amount}`];
    }
  }
  return unique;
}

// The table from the deployment's pricing pages: the pages in the deployment's language first
// (unmarked pages count as it), then the shallowest; a plan and amount another language's page
// repeats ("/de/pricing") is one row, from the first. Pure.
export function buildPriceTable(
  pages: readonly { url: string; facts: PageFacts | null | undefined }[],
  readAt: Date,
  language?: string,
): PriceTable {
  const lang = language && language !== "auto" ? primaryLanguage(language) : undefined;
  const rank = (url: string) => {
    const own = pathLanguage(url);
    return !own || (lang && primaryLanguage(own) === lang) ? 0 : 1;
  };
  const depth = (url: string) => new URL(url).pathname.split("/").filter(Boolean).length;
  const ordered = [...pages].sort(
    (a, b) => rank(a.url) - rank(b.url) || depth(a.url) - depth(b.url) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  const rows: PriceRow[] = [];
  for (const page of ordered) {
    for (const r of pagePriceRows(page.url, page.facts)) {
      const same = (o: PriceRow) => o.plan.toLowerCase() === r.plan.toLowerCase() && o.value === r.value && o.currency === r.currency;
      if (!rows.some(same)) rows.push(r);
    }
  }
  const gap = rows.length ? undefined : pricingGap(ordered);
  return { rows, pages: ordered.map((p) => p.url), readAt: readAt.toISOString(), hash: priceRowsHash(rows), ...(gap && { gap }) };
}

// A figure's line that doesn't state a plan's price: a quote or a figure the sales team tailors
// ("starting under USD 1,495", "custom pricing": acumatica.com's industry pages).
const QUOTE_LINE =
  /\b(?:starting under|under (?:USD|\$)|custom(?:ized)? pric|tailored|on request|by quote|request a quote|get a quote|contact (?:us|sales) for)\b/i;

// With no rows, why: the first pricing page stating a price that no plan could be read from
// ("unread": the card and Needs attention name it), else the first pricing page, its prices by
// quote. Undefined without a pricing page. Pure.
export function pricingGap(pages: readonly { url: string; facts: PageFacts | null | undefined }[]): PriceTable["gap"] {
  const stated = (p: (typeof pages)[number]) => (p.facts?.prices ?? []).filter((f) => !QUOTE_LINE.test(f.line));
  const unread = pages.find((p) => stated(p).length);
  if (unread) return { kind: "unread", url: unread.url, figures: stated(unread).length };
  return pages[0] && { kind: "quote", url: pages[0].url };
}

// What a person should check about a table's rows, whoever read them, each row saying why (it keeps
// a doubt the proof gave it). Not by the plans' words: by what the rows say about each other. Pure.
// - a plan's name that reads as a badge, a heading or a sentence (planNameDoubt);
// - two different prices for one plan on the same terms: which applies isn't said;
// - a plan cheaper by the year than by the month;
// - a figure a hundred times its plan's peers, on the same terms.
export function priceDoubts(rows: readonly PriceRow[]): PriceRow[] {
  // The reader's own note on a billing toggle tells a person nothing: a visitor reads both prices alike.
  const terms = (r: PriceRow) => JSON.stringify([r.period ?? "", r.unit ?? "", r.currency ?? "", [...shownQualifiers(r)].sort()]);
  const peers = rows.filter((r) => !r.addOn && r.value > 0 && !r.unit);
  return rows.map((r) => {
    const reasons: string[] = r.doubt ? [r.doubt] : [];
    const name = r.addOn ? undefined : planNameDoubt(r.plan);
    if (name) reasons.push(name);
    const own = rows.filter((o) => o.plan.toLowerCase() === r.plan.toLowerCase() && o !== r && Boolean(o.addOn) === Boolean(r.addOn));
    const twin = own.find((o) => o.value !== r.value && terms(o) === terms(r));
    if (twin)
      reasons.push(
        `It has the same terms as ${twin.amount} for ${r.plan}: nothing says which applies, and visitors see both. Say what tells them apart.`,
      );
    const sameUnit = (o: PriceRow) => (o.unit ?? "") === (r.unit ?? "") && o.currency === r.currency;
    if (r.period === "year" && own.some((o) => o.period === "month" && sameUnit(o) && !o.qualifiers?.length && o.value > r.value))
      reasons.push(`It's less for a year than ${r.plan} is for a month.`);
    const others = peers.filter((o) => o !== r && o.currency === r.currency && o.period === r.period).map((o) => o.value);
    if (!r.addOn && !r.unit && others.length >= 2) {
      const middle = [...others].sort((a, b) => a - b)[Math.floor(others.length / 2)]!;
      if (middle > 0 && (r.value > middle * 100 || (r.value > 0 && r.value * 100 < middle)))
        reasons.push(`It's far from the other plans' prices (about ${middle}).`);
    }
    const { doubt: _old, ...rest } = r;
    return reasons.length ? { ...rest, doubt: [...new Set(reasons)].join(" ") } : rest;
  });
}

// ---- a re-read, by meaning (build 8) ----

type ReadRow = Pick<PriceRow, "plan" | "amount" | "value" | "currency" | "period" | "unit" | "qualifiers">;
const ADDED_BY_HAND = "Added by hand";
const planKey = (plan: string) =>
  plan
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(?:plans?|tier|package)$/, "");
// "Premium" and "Premium plan", "Teams" and "Teams Starter": one name's words within the other's.
const nameWithin = (a: string, b: string) => {
  const [x, y] = [planKey(a).split(" "), planKey(b).split(" ")];
  return x.every((w) => y.includes(w)) || y.every((w) => x.includes(w));
};
const sameFigure = (a: ReadRow, b: ReadRow) => a.value === b.value && (!a.currency || !b.currency || a.currency === b.currency);
const clashes = <T>(a: T | undefined, b: T | undefined) => a !== undefined && b !== undefined && a !== b;
// The numbers in what tells a price apart ("10,000 emails"): a qualifier's words may vary from one
// reading to the next, a volume's figure doesn't. A label that carries the meaning is compared.
const volumes = (r: ReadRow) =>
  shownQualifiers({ url: "", line: "", ...r })
    .join(" ")
    .match(/\d[\d.,]*/g)
    ?.join("|");
const sameTerms = (a: ReadRow, b: ReadRow) => !clashes(a.period, b.period) && !clashes(volumes(a), volumes(b));
const said = (r: ReadRow) => {
  const terms = rowTerms({ url: "", line: "", ...r });
  const notes = shownQualifiers({ url: "", line: "", ...r }).join(", ");
  return `${r.amount}${terms ? ` ${terms}` : ""}${notes ? ` (${notes})` : ""}`;
};

// What a new reading says differently from the last, in words, compared by meaning: each plan and its
// figure, period and volume. Not a row's wording, the line it came from or its doubt. Rows a person
// corrected are compared as the page read them (readAs), rows they added aren't, and rows they
// removed still count as read. A row a person corrected before readAs existed (only its plan in
// `edited`) matches on its figure, and says nothing when it finds none. Empty: the same. Pure.
export function pageChanges(stored: PriceTable, rebuilt: PriceTable, confirmation?: PriceTableConfirmation | null): string[] {
  const legacy = new Set([...(stored.edited ?? []), ...(confirmation?.edited ?? [])].map(planKey));
  const before: (ReadRow & { soft?: boolean })[] = [
    ...stored.rows.flatMap((r) =>
      r.readAs ? [{ ...r, ...r.readAs }] : r.line === ADDED_BY_HAND ? [] : [{ ...r, ...(legacy.has(planKey(r.plan)) && { soft: true }) }],
    ),
    ...(stored.removedByHand ?? []),
  ];
  const after: ReadRow[] = [...rebuilt.rows];
  const pair = (fits: (b: (typeof before)[number], a: ReadRow) => boolean, then?: (b: ReadRow, a: ReadRow) => void) => {
    for (const b of [...before]) {
      const at = after.findIndex((a) => fits(b, a));
      if (at < 0) continue;
      then?.(b, after[at] as ReadRow);
      after.splice(at, 1);
      before.splice(before.indexOf(b), 1);
    }
  };
  pair((b, a) => planKey(b.plan) === planKey(a.plan) && sameFigure(b, a) && sameTerms(b, a));
  pair((b, a) => nameWithin(b.plan, a.plan) && sameFigure(b, a) && sameTerms(b, a));
  pair((b, a) => Boolean(b.soft) && sameFigure(b, a));
  const out: string[] = [];
  pair(
    (b, a) => planKey(b.plan) === planKey(a.plan),
    (b, a) => out.push(`${a.plan} was ${said(b)}, now ${said(a)}`),
  );
  pair(
    (b, a) => sameFigure(b, a) && sameTerms(b, a),
    (b, a) => out.push(`${b.plan} now reads ${a.plan}, at ${said(a)}`),
  );
  for (const b of before) if (!b.soft) out.push(`${b.plan} (${said(b)}) is no longer on the pricing page`);
  for (const a of after) out.push(`${a.plan} (${said(a)}) is new on the pricing page`);
  return out;
}

// Whether the table has anything of a person's in it that a reading mustn't simply overwrite.
const handWork = (t: PriceTable) =>
  Boolean(t.edited?.length || t.removedByHand?.length || t.rows.some((r) => r.readAs || r.line === ADDED_BY_HAND));

// Whether the rebuilt table replaces the stored one. A table nobody has looked at takes any new
// reading. One a person confirmed or corrected takes it only when the page says something different
// by meaning (pageChanges); a reading the model couldn't do is no evidence either way. Pure.
export function replacesTable(
  stored: PriceTable | null | undefined,
  rebuilt: PriceTable,
  confirmation: PriceTableConfirmation | null | undefined,
): boolean {
  if (!stored) return rebuilt.rows.length > 0 || Boolean(rebuilt.gap);
  if (stored.hash === rebuilt.hash) return !rebuilt.rows.length && JSON.stringify(stored.gap) !== JSON.stringify(rebuilt.gap);
  const confirmed = confirmation?.hash === stored.hash;
  if (!confirmed && !handWork(stored)) return true;
  // The page reads as it did when a person corrected the table (a correction from before readAs).
  if (confirmed && confirmation.readHash === rebuilt.hash) return false;
  if (rebuilt.modelError) return false;
  return pageChanges(stored, rebuilt, confirmation).length > 0;
}

// The table a changed reading leaves: the reading's rows, with a person's corrections on the rows that
// didn't change and the rows they added, without those they removed, and the difference in words when
// someone had confirmed the rows before. The hash then differs from the confirmation's: re-opened. Pure.
export function changedTable(stored: PriceTable, rebuilt: PriceTable, confirmation?: PriceTableConfirmation | null): PriceTable {
  const gone = (r: PriceRow) => stored.removedByHand?.some((x) => planKey(x.plan) === planKey(r.plan) && sameFigure(x, r));
  const rows = [
    ...rebuilt.rows
      .filter((r) => !gone(r))
      .map((r) => stored.rows.find((s) => s.readAs && planKey(s.readAs.plan) === planKey(r.plan) && sameFigure(s.readAs, r)) ?? r),
    ...stored.rows.filter((r) => r.line === ADDED_BY_HAND),
  ];
  const changes = confirmation ? pageChanges(stored, rebuilt, confirmation) : [];
  return {
    ...rebuilt,
    rows,
    hash: priceRowsHash(rows),
    ...(stored.edited?.length && { edited: stored.edited }),
    ...(stored.removedByHand?.length && { removedByHand: stored.removedByHand }),
    ...(changes.length && { changes }),
  };
}

// ---- the deployment's table ----

// Pages that can hold the table: any page in the sync that is a pricing page by its address or
// title (isPricingPage), the pricing and buying key pages among them. A page that failed to load
// this time keeps what it stated when it last loaded.
const READ_STATUSES = ["indexed", "processing", "queued", "failed"] as const;

// A pricing page as the model's reader gets it, and what the reader gives back.
export interface ModelPage {
  url: string;
  title?: string | null;
  text?: string | null;
  facts?: PageFacts | null;
}
export interface ModelRead {
  rows: PriceRow[];
  rejected: NonNullable<PriceTable["rejected"]>;
  // Pages the model read, and pages its call failed on (those fall back on the patterns).
  read: string[];
  failed: string[];
  // Calls made now: none when every page's text was cached.
  calls: number;
  cache: NonNullable<PriceTable["modelRead"]>;
  error?: string;
}

// Figures a page that gave rows states and no row has (toggl.com's monthly prices reached the text as
// bare "$12" and "$24", with no plan's name: the patterns read no row from such a line, so the model's
// leaving them out raised nothing, as the second opinion below only compares rows). A saving, a quote
// or a zero isn't a price to add. Pure.
const NOT_A_PRICE_LINE = /\b(?:save|saving|savings|off|discount|worth|up to|revenue|spar|sparen|ahorra|économisez)\b|%/i;
export function unplacedFigures(
  rows: readonly PriceRow[],
  pages: readonly { url: string; facts: PageFacts | null | undefined }[],
): NonNullable<PriceTable["unplaced"]> {
  const out: NonNullable<PriceTable["unplaced"]> = [];
  for (const page of pages) {
    if (!rows.some((r) => r.url === page.url)) continue;
    for (const { figure, line } of page.facts?.prices ?? []) {
      const value = Number(figureValue(figure));
      if (!Number.isFinite(value) || value <= 0 || QUOTE_LINE.test(line) || NOT_A_PRICE_LINE.test(line)) continue;
      const currency = currencyOf(figure);
      if (rows.some((r) => r.value === value && (!currency || !r.currency || r.currency === currency))) continue;
      if (!out.some((o) => o.figure === figure)) out.push({ figure, url: page.url, line });
    }
  }
  return out.slice(0, 12);
}

// The note as it stands now, for a table read before it existed (toggl.com's: nothing showed until the
// next sync) or with rows added since (it went on saying "no row has them"). Reads no model. Pure.
export function currentUnplaced(table: PriceTable, pages: readonly { url: string; facts: PageFacts | null | undefined }[]): PriceTable {
  const { unplaced: _old, ...rest } = table;
  const unplaced = unplacedFigures(table.rows, pages);
  return { ...rest, ...(unplaced.length && { unplaced }) };
}

// The table from the model's rows, with the patterns for the pages its call failed on. No model
// (no reader given, or nothing it could read): the patterns' table. Pure.
export function combineRead(patterns: PriceTable, pages: readonly ModelPage[], read: ModelRead | undefined): PriceTable {
  const ordered = pages.map((p) => ({ url: p.url, facts: p.facts }));
  const withDoubts = (table: PriceTable, builtBy: NonNullable<PriceTable["builtBy"]>, more: Partial<PriceTable>): PriceTable => {
    const rows = priceDoubts(table.rows);
    const unplaced = unplacedFigures(rows, ordered);
    return { ...table, rows, hash: priceRowsHash(rows), builtBy, ...more, ...(unplaced.length && { unplaced }) };
  };
  if (!read) return withDoubts(patterns, "patterns", {});
  const model = {
    ...(read.rejected.length && { rejected: read.rejected }),
    ...(read.error && { modelError: read.error }),
    modelRead: read.cache,
  };
  // The call failed everywhere, or the proof rejected everything it proposed: the patterns stand in.
  if (!read.read.length || (!read.rows.length && read.rejected.length)) return withDoubts(patterns, "patterns", model);
  const fallback = read.failed.length
    ? patterns.rows.filter(
        (r) => read.failed.includes(r.url) && !read.rows.some((o) => o.plan.toLowerCase() === r.plan.toLowerCase() && o.value === r.value),
      )
    : [];
  // A second opinion: a figure the patterns read under a plan the model names, and the model left out,
  // is listed for a person to check (savvycal.com's "Premium$17/user/mo").
  const left = patterns.rows
    .filter(
      (r) =>
        read.read.includes(r.url) &&
        read.rows.some((o) => o.plan.toLowerCase() === r.plan.toLowerCase()) &&
        !read.rows.some((o) => o.value === r.value && o.currency === r.currency),
    )
    .map((r) => ({
      ...r,
      qualifiers: (r.qualifiers ?? []).filter((q) => !q.startsWith("billing toggle") && !/as the page states/.test(q)),
      doubt: `The model didn't list this figure, which the page states as: "${r.line}".`,
    }));
  const rows = priceDoubts([...read.rows, ...fallback, ...left]);
  const gap = rows.length ? undefined : pricingGap(ordered);
  const unplaced = unplacedFigures(rows, ordered);
  return {
    rows,
    ...(unplaced.length && { unplaced }),
    pages: [...new Set([...read.read, ...fallback.map((r) => r.url)])],
    readAt: patterns.readAt,
    hash: priceRowsHash(rows),
    ...(gap && { gap }),
    builtBy: fallback.length || read.failed.length ? "model+patterns" : "model",
    ...model,
  };
}

// What's new about a rebuilt table when its rows stand: who built it, the model's cache and the
// doubts (not on rows a person corrected: their correction cleared them). Undefined: nothing new.
function withNewNotes(
  stored: PriceTable,
  rebuilt: PriceTable,
  confirmation: PriceTableConfirmation | null | undefined,
): PriceTable | undefined {
  const edited = new Set([...(stored.edited ?? []), ...(confirmation?.edited ?? [])].map((p) => p.toLowerCase()));
  const doubtFor = (r: PriceRow) =>
    edited.has(r.plan.toLowerCase()) || r.readAs || r.doubtAccepted
      ? undefined
      : rebuilt.rows.find((o) => o.plan === r.plan && o.value === r.value && o.period === r.period)?.doubt;
  const rows = stored.rows.map((r) => {
    const { doubt: _old, ...rest } = r;
    const doubt = doubtFor(r);
    return doubt ? { ...rest, doubt } : rest;
  });
  const { rejected: _r, modelError: _e, builtBy: _b, modelRead: _m, unplaced: _u, ...kept } = stored;
  const next: PriceTable = {
    ...kept,
    rows,
    ...(stillUnplaced(rows, rebuilt.unplaced).length && { unplaced: stillUnplaced(rows, rebuilt.unplaced) }),
    ...(rebuilt.builtBy && { builtBy: rebuilt.builtBy }),
    ...(rebuilt.rejected && { rejected: rebuilt.rejected }),
    ...(rebuilt.modelError && { modelError: rebuilt.modelError }),
    ...(rebuilt.modelRead && { modelRead: rebuilt.modelRead }),
  };
  const notes = (t: PriceTable) =>
    JSON.stringify([t.rows.map((r) => r.doubt ?? ""), t.builtBy, t.rejected, t.modelError, t.modelRead, t.unplaced ?? []]);
  return notes(next) === notes(stored) ? undefined : next;
}

// Rebuilds the deployment's price table from its pricing pages and writes it when its rows changed
// (replacesTable), or its notes when only they did. `read`: the model's reader (the worker's sync;
// without it the patterns read the facts, and nothing costs anything). Returns the table now stored
// (undefined: none), whether its rows changed, and the calls made.
export async function priceTableFor(
  deploymentId: string,
  opts: {
    now?: Date;
    database?: Db;
    read?: (pages: readonly ModelPage[], cache: PriceTable["modelRead"]) => Promise<ModelRead>;
  } = {},
): Promise<{
  table?: PriceTable;
  changed: boolean;
  before?: PriceTable;
  confirmation?: PriceTableConfirmation;
  calls?: number;
  error?: string;
}> {
  const database = opts.database ?? db();
  const now = opts.now ?? new Date();
  const [d] = await database
    .select({ language: deployments.language, table: deployments.priceTable, confirmation: deployments.priceTableConfirmation })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!d) return { changed: false };
  const rows = await database
    .select({
      url: contentPages.url,
      title: contentPages.title,
      facts: contentPages.facts,
      keyIntent: contentPages.keyIntent,
      text: contentPages.text,
    })
    .from(contentPages)
    .where(and(eq(contentPages.deploymentId, deploymentId), inArray(contentPages.status, [...READ_STATUSES])));
  // A pricing key page counts whatever its address says (round 7: northwesternenergy.com's rates
  // pages were pricing key pages, and the card said "no pricing page was found").
  const pages = rows.filter((r) => r.keyIntent === "price" || isPricingPage(r.url, r.title));
  // One row per page, whatever its spelling.
  const seen = new Set<string>();
  const unique = pages.filter((p) => {
    const key = pageKey(p.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const patterns = buildPriceTable(unique, now, d.language);
  // The key pages first, then in the table's order: the model's calls are bounded.
  const inOrder = patterns.pages.map((url) => unique.find((p) => p.url === url)!);
  const forModel = [...inOrder.filter((p) => p.keyIntent === "price"), ...inOrder.filter((p) => p.keyIntent !== "price")];
  const read = opts.read ? await opts.read(forModel, d.table?.modelRead) : undefined;
  // The model refused because the account is blocked: a table it built isn't swapped for the
  // patterns' over that. It's read again after the block.
  if (read?.error && !read.read.length && d.table?.rows.length && accountBlockState(new Error(read.error)))
    return { table: d.table, changed: false, error: read.error };
  const rebuilt = combineRead(patterns, forModel, read);
  const costs = { ...(read?.calls && { calls: read.calls }), ...(read?.error && { error: read.error }) };
  if (!replacesTable(d.table, rebuilt, d.confirmation)) {
    const noted = d.table ? withNewNotes(d.table, rebuilt, d.confirmation) : undefined;
    if (noted) await database.update(deployments).set({ priceTable: noted }).where(eq(deployments.id, deploymentId));
    return { ...((noted ?? d.table) && { table: noted ?? d.table! }), changed: false, ...costs };
  }
  const next = d.table ? changedTable(d.table, rebuilt, d.confirmation) : rebuilt;
  await database.update(deployments).set({ priceTable: next }).where(eq(deployments.id, deploymentId));
  return {
    table: next,
    changed: true,
    ...(d.table && { before: d.table }),
    ...(d.confirmation && { confirmation: d.confirmation }),
    ...costs,
  };
}

// Whether a rebuilt table asks a person to confirm again: it changed rows that were confirmed
// (review.ts priceTableState then says "changed", and the deployment is in Needs attention). Pure.
export const needsConfirmingAgain = (table: PriceTable | undefined, confirmation: PriceTableConfirmation | undefined): boolean =>
  Boolean(table?.rows.length && confirmation && confirmation.hash !== table.hash);
