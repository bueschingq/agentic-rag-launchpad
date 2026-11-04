// The price table check (round 6, item 1): what a reply says each plan costs, against the
// deployment's confirmed price table. One pure function for the widget, validation, the picker and
// the overnight re-run, so the same text and table always get the same answer. Browser-safe and
// dependency-free: the widget bundles it.
//
// A contradiction is a table plan given another amount than the table's (in any of its periods),
// a table plan's amount from a page that isn't a pricing page, or a reply saying a plan's price
// isn't listed when the table has it (in the period it denies, when it names one). An amount the
// table doesn't have (an add-on, a setup fee) isn't a contradiction: it's a price to check, as
// before. A figure the table has, given for a plan the table doesn't have ("Professional is $99"
// when the table's $99 is Business, or names no Professional), is unverified (round 7: a figure
// match isn't a plan match).

import type { PriceRow, PriceTable, PriceTableConfirmation } from "@launchpad/db";
import type { WidgetStrings } from "./i18n.ts";
import { isPriceWord, matchWords, sameWord } from "./relevance.ts";
import { isFrame, negativeClaim, priceAmounts } from "./verdict.ts";

export type { PriceRow, PriceTable, PriceTableConfirmation };

export interface PriceContradiction {
  // The plan as the table names it.
  plan: string;
  // What the reply says: its amount ("$6,200", "$600–$700"), or the sentence denying the price.
  said: string;
  // The table's row for the plan (the first, when it has several periods; the one in the period
  // denied, for a denial that names one).
  table: PriceRow;
  // "start": "plans start at $12", when the table's lowest plan is another figure.
  reason: "amount" | "source" | "unlisted" | "start";
}

export interface PriceClaims {
  contradictions: PriceContradiction[];
  // Amounts the reply states that no row has, as written: prices to check.
  unlisted: string[];
  // Amounts the reply gives for a plan the table doesn't name, as written with that plan: never a
  // match with the table.
  unverified?: { plan: string; said: string }[];
}

// The table, only while a person's confirmation is for these rows.
export function confirmedTable(d: {
  priceTable?: PriceTable | null;
  priceTableConfirmation?: PriceTableConfirmation | null;
}): PriceTable | undefined {
  const t = d.priceTable;
  return t?.rows.length && d.priceTableConfirmation?.hash === t.hash ? t : undefined;
}

// A short, stable hash of the rows (cyrb53, 64 bits), for a table edited by hand.
export function priceRowsHash(rows: readonly PriceRow[]): string {
  const text = JSON.stringify(
    rows.map((r) => [r.plan, r.value, r.currency ?? "", r.unit ?? "", r.period ?? "", r.url, ...(r.addOn ? ["add-on"] : [])]),
  );
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const sameUrl = (u: string) =>
  u
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRICE_WORD =
  /(?<![\p{L}])(?:pric\p{L}*|cost\p{L}*|fees?|rates?|preis\p{L}*|kosten|precio\p{L}*|tarif\p{L}*|prix|prijs\p{L}*|preço\p{L}*|prezz\p{L}*)(?![\p{L}])/iu;
const YEAR_WORD = /annu|year|\byr\b|jahr|jähr|anual|año|jaar|anno/i;
const MONTH_WORD = /month|\bmo\b|monat|mensu|\bmes\b|mois|maand|\bmese\b/i;

// The same amount in one of the row's periods: $26 a month is $312 a year.
const matches = (v: number, r: PriceRow) =>
  Math.abs(v - r.value) < 0.005 ||
  (r.period === "month" && Math.abs(v - r.value * 12) < 0.5) ||
  (r.period === "year" && Math.abs(v * 12 - r.value) < 0.5);

// A row in a period: its own, or its billing ("$15 per month, billed annually" is a yearly price, and
// never the answer to what paying monthly costs: SmugMug's Pro is $37 so, and $52 month to month).
const billedYearly = (r: PriceRow) => YEAR_WORD.test([r.unit, ...(r.qualifiers ?? [])].join(" "));
const inPeriod = (r: PriceRow, period: "year" | "month") =>
  period === "year" ? r.period === "year" || billedYearly(r) : (r.period === "month" || !r.period) && !billedYearly(r);

// What a visitor may read of a row's qualifiers: not the reader's own notes on how it read the row
// (round 7: "(period as the page states for its other plans)" reached visitors).
// Nor what the row's unit already says.
export const shownQualifiers = (r: PriceRow): string[] =>
  (r.qualifiers ?? []).filter((q) => !/as the page states|billing toggle/i.test(q) && q !== r.unit);

// A row's unit and period as words, each said once: a unit or an amount that already states a period
// isn't given another (build 8: "$1.65 per month per month" reached visitors from a row whose unit
// was "per month" and whose period was month). Every place that prints a row uses this.
export const rowTerms = (r: PriceRow, t = { perMonth: "per month", perYear: "per year" }): string => {
  const said = `${r.amount} ${r.unit}`;
  return [r.unit, !YEAR_WORD.test(said) && !MONTH_WORD.test(said) && (r.period === "month" ? t.perMonth : r.period === "year" && t.perYear)]
    .filter(Boolean)
    .join(" ");
};

// "Plans start at", "pricing starts from": a claim about the lowest plan.
const STARTS_AT =
  /(?<![\p{L}])(?:plans?|pricing|prices?|subscriptions?|accounts?)\s+(?:\p{L}+\s+)?(?:start|starts|begin|begins)\s+(?:at|from)(?![\p{L}])/iu;

// A reply's clauses: lines, sentences and semicolons.
const clausesOf = (text: string) =>
  text
    .normalize("NFC")
    .split(/\n+|;\s+|(?<=[.!?…])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);

// ---- plans a reply names that the table may not have ----

export type Span = { plan: string; at: number; end: number };

// The table plans a text names, each once, the longest first, with where.
function plansNamed(text: string, plans: readonly string[]): Span[] {
  const out: Span[] = [];
  for (const plan of plans) {
    for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(plan)}(?![\\p{L}\\p{N}])`, "giu"))) {
      const end = m.index + m[0].length;
      if (!out.some((o) => m.index < o.end && end > o.at)) out.push({ plan, at: m.index, end });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// What a denial or a price question names beyond its frame (the telling, the absence, price words
// and plans in general), and beyond `also`.
const FRAME =
  /^(?:page|site|website|shop|plan|tier|package|option|each|every|paid|free|full|add|addon|annual|annually|yearly|year|monthly|month|offer|pay|charge|buy|billing|billed|user|seat|sale|contact|product|service|per|pro|por|par|quel|sont|vos|votre|prix|sind|ihre?|cuale|son|sus|hoeveel|zijn|uw|quai|sao|quali|sono|\d+)$/;
const specifics = (s: string, also: ReadonlySet<string>) =>
  matchWords(s).filter((w) => !FRAME.test(w) && !isFrame(w) && !isPriceWord(w) && !also.has(w));

// What a denial denies, past its price word ("the price for custom integrations"): the words
// that name it, beyond the frame and the question's own.
function deniedObject(clause: string, allowed: ReadonlySet<string>): string[] {
  const m = clause.match(/(?:pric\p{L}*|costs?|fees?|rates?|amounts?)\s+(?:for|of|on)\s+(.+)$/iu);
  return specifics(m?.[1] ?? "", allowed);
}

// The host labels of the table's pages ("buzzsprout" for www.buzzsprout.com): a brand, not a thing.
const hostWords = (table: PriceTable) =>
  new Set(table.pages.flatMap((u) => (u.match(/^\w+:\/\/([^/]+)/)?.[1] ?? "").toLowerCase().split(".")));

// The numbers a text names, by value: "50,000", "50 000" and "50k" are one. For what a question
// asks about ("Basic for 50,000 emails"), never read off a row's page line, which can hold every tier.
const numbersIn = (text: string): number[] =>
  [...text.matchAll(/(?<![\p{L}\p{N}$£€¥.,])(\d[\d.,\s\u00a0\u202f]*\d|\d)(k\b)?/giu)].map((m) => {
    const digits = (m[1] ?? "").trim();
    const value = priceAmounts(`$${digits}`)[0]?.value ?? Number(digits);
    return m[2] ? value * 1000 : value;
  });

// The rows that answer a price question, or none. What's asked is the plan it names, its period, and
// everything else it says beyond the frame ("extra emails", "50,000 emails", another plan's name),
// which a row's plan, unit or qualifiers must say too: "extra emails on Pro" isn't Pro's $16.50, and
// "Basic for 50,000 emails" isn't Basic for 10,000. Two prices for one plan in one period, with nothing
// to tell them apart, answer nothing, when the question asks for a quantity, an extra or a billing
// period: the exact row or none, never a nearby figure, and the chat points to the pricing page. A
// plain "how much?" gets every row it names, two such prices side by side included (build 8:
// ShareFile's plans each had two unlabelled monthly prices, which voided the whole list, on the
// question validation asks of every site). The card flags those rows (priceDoubts).
export function rowsAnswering(question: string, table: PriceTable): PriceRow[] {
  const q = question.normalize("NFC");
  const plans = [...new Set(table.rows.map((r) => r.plan.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const named = plansNamed(q, plans);
  let rest = q;
  for (const m of [...named].reverse()) rest = rest.slice(0, m.at) + rest.slice(m.end);
  const period = YEAR_WORD.test(rest) ? "year" : MONTH_WORD.test(rest) ? "month" : undefined;
  const wanted = specifics(rest, hostWords(table)).filter((w) => !YEAR_WORD.test(w) && !MONTH_WORD.test(w) && !/^\d/.test(w));
  const numbers = numbersIn(rest);
  const names = new Set(named.map((m) => m.plan));
  const plain = !period && !wanted.length && !numbers.length;
  const rows = table.rows.filter((r) => {
    if (names.size && !names.has(r.plan.trim())) return false;
    if (period && !inPeriod(r, period)) return false;
    const own = [r.plan, r.unit, ...shownQualifiers(r)].join(" ");
    const has = matchWords(own);
    const counts = numbersIn(own);
    return wanted.every((w) => has.some((h) => sameWord(h, w))) && numbers.every((n) => counts.includes(n));
  });
  const apart = (r: PriceRow) => `${r.plan.trim()}|${r.period ?? ""}|${shownQualifiers(r).join()}|${r.unit ?? ""}|${billedYearly(r)}`;
  const same = new Map<string, number>();
  for (const r of plain ? [] : rows) {
    const had = same.get(apart(r));
    if (had !== undefined && had !== r.value) return [];
    same.set(apart(r), r.value);
  }
  return rows.slice(0, 12);
}

// Whether a question asks only what things cost: no quantity, extra or billing period (rowsAnswering
// gives it every row it names). Getting only the pricing page's link on one is held. Pure.
export function plainPriceQuestion(question: string, table: PriceTable): boolean {
  const plans = [...new Set(table.rows.map((r) => r.plan.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let rest = question.normalize("NFC");
  for (const m of plansNamed(rest, plans).reverse()) rest = rest.slice(0, m.at) + rest.slice(m.end);
  return (
    !YEAR_WORD.test(rest) &&
    !MONTH_WORD.test(rest) &&
    !numbersIn(rest).length &&
    !specifics(rest, hostWords(table)).some((w) => !/^\d/.test(w))
  );
}

// One row as the visitor reads it: "**Premium**: $26.00 per user per month (billed annually)".
// Markdown in a plan's name would be read as formatting.
export const rowLine = (row: PriceRow, t: Pick<WidgetStrings, "perMonth" | "perYear">): string =>
  `- **${row.plan.replace(/[*_`[\]]/g, "")}**: ${[row.amount, rowTerms(row, t)].filter((s) => s?.trim()).join(" ")}${
    shownQualifiers(row).length ? ` (${shownQualifiers(row).join(", ")})` : ""
  }`;

export interface PriceClaimOptions {
  // The visitor's question: a figure given with no plan is the plan asked about's, and a denial
  // counts only when what it denies is what was asked (round 7, items 1 and 4).
  question?: string;
  // Names the text gives as plans the table may not have (strangersIn in price-names.ts): the
  // console's, for what it calls a match. The widget leaves it out for its size: a figure for a plan
  // the table doesn't name is no contradiction there either.
  strangers?: (text: string, taken: readonly Span[], figures: readonly { at: number }[]) => Span[];
  // A table no person has confirmed may lack rows (round 7: SavvyCal's read table had no Premium
  // $200, and an answer stating it was held). A figure no row has isn't a contradiction when this
  // says the pricing page pairs it with that plan. The chat, with no page text, passes () => true:
  // only another row's figure contradicts an unconfirmed table there.
  listed?: (plan: string, value: number) => boolean;
}

// What a figure says it's for, when that isn't the plan's price: "$1.80 / 1,000", "$1.30 per 1,000
// emails", "$5 per GB" against a row per user, "$10 setup fee". Not a period, and not the row's unit.
const AFTER_FIGURE = /^\s*(?:\/|per\b|pro\b|por\b|par\b|je\b)\s*(\d[\d.,]*\s*k?\b)?\s*(\p{L}+)?/iu;
const OWN_CHARGE =
  /^\s*(?:\p{L}+[ -]){0,2}?(?:fees?|charges?|gebühr\p{L}*|\p{L}+gebühr\p{L}*|frais|cargos?|comisi[oó]n\p{L}*)(?![\p{L}])/iu;
function forSomethingElse(after: string, rows: readonly PriceRow[]): boolean {
  if (OWN_CHARGE.test(after)) return true;
  const m = after.match(AFTER_FIGURE);
  if (!m) return false;
  if (m[1]) return true;
  const noun = m[2] ?? "";
  if (!noun || YEAR_WORD.test(noun) || MONTH_WORD.test(noun)) return false;
  const units = rows.flatMap((r) => (r.unit ? matchWords(r.unit) : []));
  return units.length > 0 && !matchWords(noun).some((w) => units.some((u) => sameWord(u, w)));
}

export function checkPriceClaims(
  answer: string,
  table: PriceTable | undefined,
  citedUrls: readonly string[],
  language?: string,
  opts: PriceClaimOptions = {},
): PriceClaims {
  const out: PriceClaims = { contradictions: [], unlisted: [] };
  if (!table?.rows.length || !answer.trim()) return out;
  const plans = [...new Set(table.rows.map((r) => r.plan.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const rowsOf = (plan: string) => table.rows.filter((r) => r.plan.trim() === plan);
  const pricing = new Set([...table.pages, ...table.rows.map((r) => r.url)].map(sameUrl));
  const fromPricing = !citedUrls.length || citedUrls.some((u) => pricing.has(sameUrl(u)));
  const seen = new Set<string>();
  const add = (c: PriceContradiction) => {
    const key = `${c.plan}|${c.reason}`;
    if (!seen.has(key)) out.contradictions.push(c);
    seen.add(key);
  };
  const unverified: { plan: string; said: string }[] = [];
  const question = opts.question?.normalize("NFC") ?? "";
  const asked = question ? plansNamed(question, plans).map((m) => m.plan) : [];
  const askedStranger = question && !asked.length ? opts.strangers?.(question, [], [])[0]?.plan : undefined;
  const askedPeriod = question ? (YEAR_WORD.test(question) ? "year" : MONTH_WORD.test(question) ? "month" : undefined) : undefined;
  const brand = hostWords(table);
  const questionWords = new Set([...matchWords(question), ...brand]);
  // What the question asks about beyond the frame, the brand and the table's plans ("a corporate
  // licence for 10 Macs"): a denial of the prices in general isn't about the table then.
  const askedElse = specifics(question, new Set([...brand, ...plans.flatMap(matchWords)]));
  // A denial's rows: the plans it (or else the question) names, in the period it (or the
  // question) names; none when it names another thing than what was asked.
  const deniedRows = (clause: string, named: readonly string[]): PriceRow[] => {
    const period = YEAR_WORD.test(clause) ? "year" : MONTH_WORD.test(clause) ? "month" : askedPeriod;
    let rows: PriceRow[];
    if (named.length) rows = named.flatMap(rowsOf);
    else {
      if ((opts.strangers?.(clause, [], []) ?? []).some((s) => !brand.has(s.plan.toLowerCase()))) return [];
      if (deniedObject(clause, questionWords).length) return [];
      if (asked.length) rows = asked.flatMap(rowsOf);
      else if (askedStranger || (question && askedElse.length)) return [];
      else rows = table.rows;
    }
    return period ? rows.filter((r) => inPeriod(r, period)) : rows;
  };
  const cheapest = () => {
    const plansOnly = table.rows.filter((r) => !r.addOn && r.period !== "year");
    return [...(plansOnly.length ? plansOnly : table.rows.filter((r) => !r.addOn))].sort((a, b) => a.value - b.value)[0];
  };
  const clauses = clausesOf(answer);
  const named = new Set<string>();
  let amounts = 0;
  for (const raw of clauses) {
    // Each plan named, the longest first ("Enterprise Plus" before "Enterprise"); its words taken
    // out before reading figures, so "Enterprise 1 $199" isn't read as "1 $".
    const mentions = plansNamed(raw, plans);
    let clause = raw;
    for (const m of mentions) clause = clause.slice(0, m.at) + " ".repeat(m.end - m.at) + clause.slice(m.end);
    // A name's own number before a figure, plan or not ("Enterprise 1 $199"): never "1 $".
    clause = clause.replace(/(?<=[\p{L}]\s)\d{1,2}(?=\s+[$£€¥])/gu, (d) => " ".repeat(d.length));
    for (const m of mentions) named.add(m.plan);
    // $0 is a price where the table has one ("Free: $0").
    const figures = priceAmounts(clause).filter((f) => f.value > 0 || table.rows.some((r) => r.value === 0));
    amounts += figures.length;
    const strangers = figures.length ? (opts.strangers?.(raw, mentions, figures) ?? []) : [];
    const all = [...mentions.map((m) => ({ ...m, stranger: false })), ...strangers.map((s) => ({ ...s, stranger: true }))].sort(
      (a, b) => a.at - b.at,
    );
    if (!all.length) {
      if (!figures.length) continue;
      // No plan in the clause: the plan the question names, for a figure another plan has
      // ("How much is Professional?" "It's $99 a month.", $99 being Business's).
      for (const f of figures) {
        const own = asked.length === 1 ? rowsOf(asked[0] as string) : [];
        if (
          own.length &&
          !own.some((r) => matches(f.value, r)) &&
          table.rows.some((r) => matches(f.value, r)) &&
          !forSomethingElse(clause.slice(f.end), own)
        )
          add({ plan: asked[0] as string, said: f.text, table: own[0] as PriceRow, reason: "amount" });
        else if (!asked.length && askedStranger && table.rows.some((r) => matches(f.value, r)))
          unverified.push({ plan: askedStranger, said: f.text });
        else if (!table.rows.some((r) => matches(f.value, r))) {
          // "Paid plans start at $12", with no plan named: the lowest plan says otherwise.
          const lowest = !askedElse.length && !asked.length && STARTS_AT.test(raw) ? cheapest() : undefined;
          if (lowest) add({ plan: lowest.plan, said: f.text, table: lowest, reason: "start" });
          else out.unlisted.push(f.text);
        }
      }
      continue;
    }
    if (!figures.length) {
      // "The website doesn't state Enterprise's price."
      if (mentions.length && PRICE_WORD.test(raw) && negativeClaim(raw, language)) {
        const rows = deniedRows(
          raw,
          mentions.map((m) => m.plan),
        );
        for (const m of mentions) {
          const row = rows.find((r) => r.plan.trim() === m.plan);
          if (row) add({ plan: m.plan, said: raw, table: row, reason: "unlisted" });
        }
      }
      continue;
    }
    // Each amount to its plan: the nearest named before it when the clause names a plan first
    // ("Standard is $4,500"), else the nearest after it ("$4,500 for Standard").

    const paired = new Map<string, typeof figures>();
    const strangerPaired = new Map<string, typeof figures>();
    // "Plans start at $15: Audio $15, Video $25": the figure ahead of the list is no plan's.
    const colon = raw.indexOf(": ");
    const lead = (f: { at: number }) => colon > f.at && (all[0]?.at ?? 0) > colon;
    const planFirst = (all[0]?.at ?? 0) < (figures.find((f) => !lead(f))?.at ?? 0);
    for (const f of figures) {
      if (lead(f)) continue;
      const before = all.filter((m) => m.at < f.at).at(-1);
      const after = all.find((m) => m.at > f.at);
      const m = planFirst ? (before ?? after) : (after ?? before);
      if (!m) continue;
      const into = m.stranger ? strangerPaired : paired;
      into.set(m.plan, [...(into.get(m.plan) ?? []), f]);
    }
    for (const [plan, fs] of strangerPaired) {
      for (const f of fs) {
        if (table.rows.some((r) => matches(f.value, r))) unverified.push({ plan, said: f.text });
        else out.unlisted.push(f.text);
      }
    }
    for (const [plan, fs] of paired) {
      const rows = rowsOf(plan);
      const right = fs.filter((f) => rows.some((r) => matches(f.value, r)));
      // Each figure on its own: one that matches never excuses another (round 7: "Premium is $200, or
      // $20 monthly" passed on the $20). Annual and monthly prices of one plan are both matches. A
      // figure for something else ("Basic is $15, extra emails $1.80 / 1,000") is no claim on the
      // plan's price, and the same goes for one the pricing page itself pairs with the plan, on a
      // table nobody confirmed.
      // "plus $99 a year for premium support": a figure no row has, said to be for something named.
      const forNamed = (f: (typeof fs)[number]) =>
        !table.rows.some((r) => matches(f.value, r)) &&
        /^[^,;:]*?\s(?:for|für|pour|para|voor) \p{L}/iu.test(clause.slice(f.end).replace(AFTER_FIGURE, ""));
      const elsewhere = (f: (typeof fs)[number]) => forSomethingElse(clause.slice(f.end), rows) || forNamed(f);
      const wrong = fs.filter(
        (f) => !right.includes(f) && !elsewhere(f) && !(opts.listed?.(plan, f.value) && !table.rows.some((r) => matches(f.value, r))),
      );
      if (wrong.length) {
        // A range ("$600–$700") is one claim.
        const first = wrong[0];
        const last = wrong.at(-1);
        const range = first && last && /^\s*(?:-|–|—|to|bis|a|à)\s*$/i.test(clause.slice(first.end, last.at)) && wrong.length === 2;
        const said = range ? clause.slice(first.at, last.end).trim() : wrong.map((f) => f.text).join(", ");
        add({ plan, said, table: rows[0] as PriceRow, reason: "amount" });
      } else if (right.length && !fromPricing) {
        add({ plan, said: right.map((f) => f.text).join(", "), table: rows[0] as PriceRow, reason: "source" });
      }
      for (const f of fs)
        if (!right.includes(f) && !wrong.includes(f) && !table.rows.some((r) => matches(f.value, r))) out.unlisted.push(f.text);
    }
  }
  // "No specific prices are listed", "It does not state an annual price", with no plan or amount
  // anywhere: the rows asked about, in the period denied, say otherwise.
  if (!named.size && !amounts) {
    const denial = clauses.find((c) => PRICE_WORD.test(c) && negativeClaim(c, language));
    const row = denial ? deniedRows(denial, [])[0] : undefined;
    if (denial && row) add({ plan: row.plan, said: denial, table: row, reason: "unlisted" });
  }
  out.unlisted = [...new Set(out.unlisted)];
  if (unverified.length) out.unverified = unverified;
  return out;
}

// The reply to show instead of `answer`, and the pricing page it cites as a source (titled as
// Agentic RAG retrieved it, else by its address), or undefined when it doesn't contradict the table.
// The table's rows only when they're what was asked, on plan, qualifier, period and unit
// (rowsAnswering) and a person has confirmed them; otherwise no figure at all: a line pointing to the
// pricing page, with its link as the reply's button (`pointer`, no answer). With no confirmed table,
// `pricingFacts` is what the pricing page's rows say: only another row's figure contradicts it.
// Here, not in the widget, so validation shows what the chat will show (build 8).
export function priceReplacement(
  question: string,
  answer: string,
  table: PriceTable | undefined,
  cited: readonly { title?: string; href: string }[],
  t: Pick<WidgetStrings, "prices" | "pricesOnPage" | "perMonth" | "perYear">,
  language?: string,
  pricingFacts?: PriceTable,
): { answer: string; source: { title: string; href: string }; pointer?: true } | undefined {
  const against = table ?? pricingFacts;
  if (
    !against ||
    !checkPriceClaims(
      answer,
      against,
      cited.map((s) => s.href),
      language,
      { question, ...(!table && { listed: () => true }) },
    ).contradictions.some((c) => table || c.reason === "amount")
  )
    return undefined;
  const rows = table ? rowsAnswering(question, table) : [];
  const page = rows[0]?.url ?? against.pages[0] ?? against.rows[0]?.url;
  if (!page) return undefined;
  const bare = (u: string) =>
    u
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  const url = new URL(page);
  const title =
    cited.find((s) => bare(s.href) === bare(page))?.title || `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
  const source = { title, href: url.href };
  if (!rows.length) return { answer: t.pricesOnPage, source, pointer: true };
  return { answer: [t.prices, "", ...rows.map((r) => rowLine(r, t))].join("\n"), source };
}

// The panel's line for a contradiction: "Standard is $4,500 on /pricing; this answer gives $6,200
// for Standard".
export function contradictionText(c: PriceContradiction, citedUrls: readonly string[] = []): string {
  const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
  const row = c.table;
  const per = rowTerms(row);
  const stated = `${row.plan} is ${row.amount}${per ? ` ${per}` : ""} on ${path(row.url)}`;
  if (c.reason === "unlisted") return `${stated}; this answer says it isn't listed (“${c.said}”)`;
  if (c.reason === "start") return `The lowest plan, ${stated}; this answer says plans start at ${c.said}`;
  const other = citedUrls.find((u) => sameUrl(u) !== sameUrl(row.url));
  if (c.reason === "source")
    return `${stated}; this answer gives ${c.said} from ${other ? path(other) : "another page"}, not the pricing page`;
  return `${stated}; this answer gives ${c.said} for ${row.plan}${other && !citedUrls.some((u) => sameUrl(u) === sameUrl(row.url)) ? ` from ${path(other)}` : ""}`;
}
