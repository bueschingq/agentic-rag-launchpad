// Starting points for a deployment's system prompt, filled in with the name visitors see and
// the site. Every template speaks as the website ("we", "our"), never talks about how it works
// (context, documents, sources, data), and when the website doesn't answer, replies with the
// console's no-answer sentence word for word (so the verdict and the widget's handoff see it), and
// says so when prices are by quote. For regulated sectors it also refuses the advice it must not
// give and points to a person. Today's date and the rule on past events are added to every prompt
// when it's saved (prompt.ts).

import { NO_CONTEXT_ANSWER } from "@launchpad/theme";

export const PROMPT_TEMPLATES = [
  { key: "general", label: "General" },
  { key: "healthcare", label: "Healthcare" },
  { key: "financial", label: "Financial services" },
  { key: "education", label: "Education and public sector" },
] as const;

export type PromptTemplate = (typeof PROMPT_TEMPLATES)[number]["key"];

// The name visitors see: never the partner's internal name for the customer. undefined for a
// customer saved before "Name visitors see" was required, until someone sets it.
export const visitorName = (t: { displayName?: string | null; name: string }): string | undefined => t.displayName?.trim() || undefined;

// What a template says in place of a name nobody has set yet.
const NO_NAME = "the organization";

// When the website doesn't answer: the console's own sentence, word for word (round 4). Until then
// the template asked the model to say it didn't know "in one sentence" in its own words, and those
// words passed as answers ("We don't have specific steps for painted walls… please contact us").
// Round 5: a part of an answer is given, with what the site doesn't say; the sentence is for when
// nothing helps (the release check: "Was kostet WhatsUp Gold für 300 Geräte?" got the sentence with
// "Preis ab $1,229 für 50 Geräte" in front of the model). The user prompt says the same, last
// (prompt.ts PARTIAL_RULE), and reaches every deployment by itself.
// Answering rules 1 (round 5): what isn't stated is said of the page read, never of the whole
// website ("Our website does not list specific subscription prices" on chef.io, whose pricing page
// lists them). The user prompt says the same, last (prompt.ts PARTIAL_RULE).
export const NO_ANSWER_LINE =
  "If our website answers only part of the question, give that part, and say what the page you read doesn't state, naming the page; " +
  "never say our website as a whole doesn't list or provide something. " +
  `If nothing on our website helps with the question, reply only with this sentence, in English and word for word: ${NO_CONTEXT_ANSWER}`;
// Prices by quote: an answer, with the page to ask on (the demo's price question, round 4).
export const QUOTE_LINE =
  "If our website says prices are by quote or on request, say so, and point visitors to the page where they can ask for a quote.";
// The case asked, not a neighbouring one (round 5: slime on carpet answered with slime on asphalt).
export const CASE_LINE =
  "Answer only about the case the visitor asks about: when our website covers a similar but different product, surface or version, say what it covers instead of applying it to theirs.";

// The house rules, shared by every template.
const COMMON = (client: string, site: string) =>
  `You are the chat assistant on ${site}, the website of ${client}. Speak as ${client}: say "we", "us" and "our", as a member of our team would. ` +
  "Answer only with what our website says, and never guess or invent details such as prices, dates, names or policies. " +
  "Never mention context, documents, sources, data or how you found an answer: just answer. " +
  `${NO_ANSWER_LINE} ` +
  `${QUOTE_LINE} ` +
  `${CASE_LINE} ` +
  "Be friendly, clear and brief: under 120 words, plain language, short paragraphs or a short list. " +
  "Never ask for personal details such as account numbers, passwords or health information.";

const SECTOR: Record<PromptTemplate, string> = {
  general: "",
  healthcare:
    "You give general information only, never medical advice: don't diagnose, don't recommend or adjust treatments, medicines or doses, " +
    "and don't interpret symptoms or results. For anything about a person's own health, suggest they contact us or their own clinician. " +
    "If someone describes an emergency, tell them to call their local emergency number now.",
  financial:
    "You give general information only, never financial, investment, tax or legal advice: don't recommend products, " +
    "predict returns or say what someone should do with their money. Rates, fees and terms can change: link the page that gives them." +
    "For anything about a person's own account or situation, suggest they contact us directly.",
  education:
    "Keep to our published information: courses, admissions, deadlines, fees, services and contacts. " +
    "Don't make commitments on our behalf, such as admission decisions or eligibility; point to the office that decides.",
};

// `client` is the name visitors see (visitorName), never the internal customer name.
export function promptFromTemplate(template: PromptTemplate, client: string | undefined, siteUrl: string): string {
  let site = siteUrl;
  try {
    site = new URL(siteUrl).host;
  } catch {
    // keep what was given
  }
  const name = client?.trim() || NO_NAME;
  const sector = SECTOR[template];
  return sector ? `${COMMON(name, site)}\n\n${sector}` : COMMON(name, site);
}

// ---- bringing a saved prompt up to the current template ----
//
// "Update the prompt" (Review's Client's name line, a name change, Bring up to date): the
// current template with the name visitors see, plus every line the partner added, with any other
// name for the client changed to that one. Lines from a template (this one, or another sector's)
// are replaced by today's wording. A line is left out, and shown with why, when it opens the
// prompt as the template does ("You are the website assistant for …") or invites answers that
// talk about how the chatbot works ("Answer only from the provided context").

// A sentence per item; a line break also ends one, so the partner's own lines stay apart.
export const promptSentences = (line: string): string[] =>
  line
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/)
    .filter(Boolean);

// Characters from Unicode's private use area, which no prompt contains: the gaps a template's
// client and site leave, and the markers around a masked name.
const CLIENT_GAP = "\uE001";
const SITE_GAP = "\uE002";
const MARK_OPEN = "\uE004";
const MARK_CLOSE = "\uE005";
const MARKED = /\uE004(\d+)\uE005/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Sentences earlier templates had, which "Update the prompt" replaces with today's wording rather
// than keeping as the partner's own: the don't-know line until round 4.
const RETIRED_SENTENCES = [
  "If our website doesn't say, reply in one sentence that you don't know, and suggest contacting us.",
  // Round 4's no-answer line, before a part of an answer was allowed.
  `If our website doesn't answer the question, reply only with this sentence, in English and word for word: ${NO_CONTEXT_ANSWER}`,
  // Round 5's first partial-answer line, which said what "it" (the website) doesn't say.
  "If our website answers only part of the question, give that part and say what it doesn't say.",
];

// Each template's sentences as patterns, any client and site filling the gaps.
const TEMPLATE_SENTENCES: { template: PromptTemplate; pattern: RegExp }[] = [
  ...PROMPT_TEMPLATES.flatMap(({ key }) =>
    promptFromTemplate(key, CLIENT_GAP, SITE_GAP)
      .split("\n")
      .flatMap(promptSentences)
      .map((sentence) => ({
        template: key,
        pattern: new RegExp(`^${escapeRegExp(sentence).replaceAll(CLIENT_GAP, "(.+?)").replaceAll(SITE_GAP, "(.+?)")}$`),
      })),
  ),
  ...RETIRED_SENTENCES.map((sentence) => ({ template: "general" as const, pattern: new RegExp(`^${escapeRegExp(sentence)}$`) })),
];

// Whether a saved prompt has today's template lines (the no-answer sentence and prices by quote)
// and none of the retired ones: Bring up to date offers "Update the prompt" when it hasn't.
export function templateLinesCurrent(prompt: string): boolean {
  const sentences = prompt.split("\n").flatMap(promptSentences);
  return (
    prompt.includes(NO_ANSWER_LINE) &&
    prompt.includes(QUOTE_LINE) &&
    prompt.includes(CASE_LINE) &&
    !sentences.some((x) => RETIRED_SENTENCES.includes(x.trim().replace(/\s+/g, " ")))
  );
}

// The template a sentence comes from, if any: "general" for the house rules every template shares.
export function templateOf(sentence: string): PromptTemplate | undefined {
  const s = sentence.trim().replace(/\s+/g, " ");
  return TEMPLATE_SENTENCES.find((t) => t.pattern.test(s))?.template;
}

const OPENER = /^you are (?:the|an?|our)\b[^.!?]*\bassistant\b/i;

// A phrase that gives the machinery away: the validation leak check's patterns, or plain text.
export type LeakPhrase = RegExp | string;
export const matchesLeak = (text: string, phrases: readonly LeakPhrase[]): boolean =>
  phrases.some((p) =>
    typeof p === "string" ? text.toLowerCase().includes(p.toLowerCase()) : new RegExp(p.source, p.flags.replace("g", "")).test(text),
  );

// Every case-insensitive occurrence of any of `names`, as one pattern. Longest first, so where
// "Crayola Company" stands, "Crayola" inside it isn't a match of its own. Part of a longer word
// ("Acme" in "Acmeville") or of an address ("crayola" in www.crayola.com, an email) doesn't count.
export function namesPattern(names: readonly string[]): RegExp | undefined {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return unique.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}@/]|[\\p{L}\\p{N}][.-])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}]|[.-][\\p{L}\\p{N}])`,
        "giu",
      )
    : undefined;
}

// Each name replaced by a numbered marker with no punctuation in it, so "Acme Inc." can't end a
// sentence; `restore` puts back the original, or `to` instead.
function maskNames(text: string, names: readonly string[]) {
  const originals: string[] = [];
  const pattern = namesPattern(names);
  const masked = pattern ? text.replace(pattern, (m) => `${MARK_OPEN}${originals.push(m) - 1}${MARK_CLOSE}`) : text;
  const restore = (s: string, to?: string) => s.replace(MARKED, (_, i: string) => to ?? originals[Number(i)]!);
  return { masked, restore };
}

// `text` with each of `others` changed to `client`. An other name that's part of the client's
// name ("Crayola" in "Crayola Company") is only changed where it stands alone.
export function renameClient(text: string, client: string, others: readonly string[]): string {
  const { masked, restore } = maskNames(text, [client, ...others]);
  return restore(masked, client.trim());
}

export interface PromptUpdate {
  prompt: string;
  template: PromptTemplate;
  // The partner's own lines, carried over (with the client's name corrected).
  kept: string[];
  // Lines left out, and why.
  dropped: { line: string; why: string }[];
}

export function updatedPrompt(
  saved: string,
  o: { client: string; siteUrl: string; otherNames: readonly string[]; leakPhrases: readonly LeakPhrase[] },
): PromptUpdate {
  const { masked, restore } = maskNames(saved, [o.client, ...o.otherNames]);
  const lines = masked.split("\n").map((line) => promptSentences(line));
  // The sector a saved prompt was started from, by the sector paragraph's sentences.
  const template =
    lines
      .flat()
      .map(templateOf)
      .find((t) => t && t !== "general") ?? "general";
  const kept: string[] = [];
  const dropped: PromptUpdate["dropped"] = [];
  const keptLines = lines.flatMap((line) => {
    const own = line.filter((sentence) => {
      if (templateOf(sentence)) return false;
      if (OPENER.test(sentence)) {
        dropped.push({ line: restore(sentence), why: "the template's own first line replaces it" });
        return false;
      }
      if (matchesLeak(restore(sentence), o.leakPhrases)) {
        dropped.push({ line: restore(sentence), why: "it invites answers that talk about how the chat works" });
        return false;
      }
      return true;
    });
    if (!own.length) return [];
    const renamed = restore(own.join(" "), o.client.trim());
    kept.push(renamed);
    return [renamed];
  });
  const base = promptFromTemplate(template, o.client, o.siteUrl);
  return { prompt: keptLines.length ? `${base}\n\n${keptLines.join("\n")}` : base, template, kept, dropped };
}
