// Reading plan names, for the console (round 7): names a reply gives as plans that a table may not
// have, and row names that may not be plans. Apart from price-claims.ts so the widget, which needs
// neither, stays within its size budget.

import type { Span } from "./price-claims.ts";

// Built on first use: a top-level RegExp or Set would stay in the widget's bundle, unused.
let read: { named: RegExp; before: RegExp; notAName: Set<string> } | undefined;
function reading() {
  if (read) return read;
  // A name as a page writes one: capitalised words, digits, "+" and "&" between ("Audio + Video",
  // "Enterprise 1", "Multi-Podcast").
  const NAME = String.raw`\p{Lu}[\p{L}\p{N}'’.-]*(?:\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}'’.-]*|[+&]))*`;
  read = {
    named: new RegExp(
      String.raw`(${NAME})\s+(?:[Pp]lan|[Tt]ier|[Pp]ackage|[Ee]dition|[Ll]icen[cs]e|[Ss]ubscription|[Bb]undle)s?(?!\p{L})`,
      "gu",
    ),
    // Directly before a figure: "Professional is $99", "Professional: $99", "Professional $99/mo".
    before: new RegExp(String.raw`(${NAME})\s*(?:[:—–-]|\b(?:is|costs?|at|for|runs?)\b)?\s*\(?$`, "u"),
    // Words that open a sentence or describe a price: never a plan.
    notAName: new Set(
      "it's it’s that's there's here's they we you i us the a an our your their its it this that these those there here pricing price prices plan plans tier tiers package packages license licence licenses licences subscription subscriptions edition paid free each every all both other any yes no and or but so if how what which when in on at for with from per monthly annual annually yearly month year billed total note plus save starts starting start cost costs only just then also one two three first usd eur gbp vat tax".split(
        " ",
      ),
    ),
  };
  return read;
}

const cleanName = (raw: string) => {
  const { notAName } = reading();
  const words = raw.trim().split(/\s+/);
  while (words.length && notAName.has(words[0]?.toLowerCase() ?? "")) words.shift();
  while (/^[+&]$/.test(words.at(-1) ?? "")) words.pop();
  return words.some((w) => !notAName.has(w.toLowerCase()) && !/^\d+$/.test(w)) ? words.join(" ") : undefined;
};

// Names the text gives as a plan ("the Professional plan", "Professional is $99"), outside the
// spans the table's plans take.
export function strangersIn(text: string, taken: readonly Span[], figures: readonly { at: number }[]): Span[] {
  const out: Span[] = [];
  const push = (raw: string, at: number) => {
    const name = cleanName(raw);
    if (!name) return;
    const from = at + raw.indexOf(name);
    const end = from + name.length;
    if (![...taken, ...out].some((t) => from < t.end && end > t.at)) out.push({ plan: name, at: from, end });
  };
  for (const m of text.matchAll(reading().named)) push(m[1] ?? "", m.index);
  for (const f of figures) {
    const head = text.slice(Math.max(0, f.at - 60), f.at);
    const m = head.match(reading().before);
    if (m?.[1]) push(m[1], f.at - head.length + (m.index ?? 0));
  }
  return out.sort((a, b) => a.at - b.at);
}

const BADGE =
  /^(?:recommended|most popular|popular|best value|great value|best seller|bestseller|best deal|new|sale|featured|our pick|top pick|staff pick|limited(?: time)?(?: offer)?|hot|most chosen|save \d+\s*%?|\d+\s*% off|beliebt|empfohlen|recomendado|populaire|recommandé)$/i;
const TITLE_WORDS =
  /(?<![\p{L}])(?:pricing|prices|price list|plans? (?:&|and) pricing|preise|precios|tarifs|prijzen|preços|prezzi)(?![\p{L}])|^(?:buy|get|shop|compare|choose|pick|order|purchase)\s/iu;
const HEADING_TAIL = /(?<![\p{L}])(?:add-?ons|extras|features|options|faqs?|benefits|included|includes)$/iu;
const SMALL_WORD = /^(?:of|and|or|for|the|a|an|with|to|in|on|per|de|du|la|le|und|y|e|\+|&|-|–)$/i;

// Why a row's plan name may not be a plan, or undefined when it reads as one. Badges
// ("Recommended", "Most popular"), page titles and headings ("Podcast hosting pricing", "Buy the
// Alfred Powerpack", "Subscription Add-ons") and feature lines ("Dynamic show notes"). Pure.
export function planNameDoubt(plan: string, pageTitle?: string | null): string | undefined {
  const name = plan.trim().replace(/\s+/g, " ");
  if (!name) return "It has no name.";
  const bare = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  if (BADGE.test(name)) return "It reads like a badge on the page, not a plan.";
  const title = pageTitle?.split(/\s[|–—-]\s/)[0];
  if ((title && bare(title) === bare(name)) || TITLE_WORDS.test(name)) return "It reads like the page's title or a heading.";
  if (HEADING_TAIL.test(name)) return "It reads like a section heading.";
  // "Transcription (5 hrs per month)" is named by what stands outside its brackets.
  const words = name.replace(/\s*\([^)]*\)/g, "").split(" ");
  if (words.length > 5) return "It reads like a feature line.";
  const lower = words.slice(1).filter((w) => !SMALL_WORD.test(w) && /^\p{Ll}/u.test(w));
  if (words.length >= 3 && lower.length >= 2) return "It reads like a feature line.";
  return undefined;
}
