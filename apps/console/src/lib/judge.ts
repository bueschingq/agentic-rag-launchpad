// The answer judge (round 5): one model call that reads a reply beside the site's own text and
// says whether it answers, through Agentic RAG's predict API with the console's account (NUA) key,
// so there's nothing to set up. Validation and the starter picker ask it about every answer, and
// the worker's nightly report roll-up about logged answers that the shared verdict counts as
// answered but that make a negative claim. It can only make a result stricter, never release one
// (judgeOutcome in validation-rules.ts). The chat never calls it.
//
// Each question and answer pair is judged once per deployment (the judgements table), so a re-run
// with the same answer costs nothing. The site's key-page facts are part of the pair's hash: when
// a sync changes what the pricing page states, the answer is judged again.
//
// Tried before building, on 2026-10-31 (review-kit/round-5/answer-quality-spike): 7 of 7 right,
// including the four round-5 blockers, in 0.8–1.9 s each. Worker-importable: no page code.

import { createHash } from "node:crypto";
import { judgements, type PageFacts, type PriceTable } from "@launchpad/db";
import { nuaZone, predictChat } from "@launchpad/par-client";
import { normalizeQuestion, questionHash, rowTerms, shownQualifiers } from "@launchpad/theme";
import { and, eq } from "drizzle-orm";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { isJudgeVerdict, type JudgeVerdict } from "./validation-rules.ts";

export { JUDGE_VERDICTS, type JudgeVerdict, judgeOutcome } from "./validation-rules.ts";

// Bumped whenever the prompt changes: earlier judgements are then asked again.
export const JUDGE_VERSION = 5;
// One judgement at most this long: validation never waits on a stuck one.
const JUDGE_TIMEOUT_MS = 12_000;
// Site text the judge reads, at most.
const MAX_SITE_TEXT = 7000;

// A key page's facts as lib/content.ts keyFacts gives them.
export interface KeyFact {
  url: string;
  title?: string;
  intent?: string;
  facts: PageFacts;
}

export interface JudgeInput {
  deploymentId: string;
  question: string;
  answer: string;
  // The passages of the pages the reply cites (else what was retrieved).
  passages: readonly string[];
  // The key pages for the question's intent, with what they state.
  keyFacts?: readonly KeyFact[];
  // Upcoming dates the site states, for "when" questions.
  events?: readonly { date: string; readAs?: string; line: string; url: string }[];
  // The price table, confirmed or read from the pricing page: what a plan costs, in each of its periods.
  priceTable?: PriceTable;
  today?: Date;
  // false: neither read nor write the judgements table (read-only checks on a review database).
  cache?: boolean;
}

export interface Judgement {
  // "unavailable": the judge couldn't be asked; the result stands as the rules left it.
  verdict: JudgeVerdict | "unavailable";
  // One line the partner sees.
  reason: string;
  cached?: boolean;
  ms?: number;
}

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// What a key page states, one line per fact, as the judge reads it.
export function factLines(pages: readonly KeyFact[]): string[] {
  return pages.flatMap((p) => {
    const at = `${p.title ? `${p.title} ` : ""}(${p.url})`;
    const f = p.facts ?? {};
    return [
      // A glued or unreadable fact never reaches the judge (round 6: "2128700sales@teamwork.com", "$ .").
      ...(f.prices ?? []).filter((x) => /\d/.test(x.figure)).map((x) => `${at} states the price ${x.figure}: "${x.line}"`),
      ...(f.contacts ?? [])
        .filter((x) => !(x.kind === "email" && /^\d{4,}/.test(x.value)))
        .map((x) => `${at} gives the ${x.kind} ${x.value}: "${x.line}"`),
      ...(f.links ?? []).map((x) => `${at} links a ${x.intent} page: ${x.label ? `${x.label} ` : ""}${x.url}`),
      ...(f.events ?? []).filter((x) => x.date).map((x) => `${at} states the date ${x.readAs || x.date}: "${x.line}"`),
    ];
  });
}

// The price table, one row per line, as the judge reads it.
export function tableLines(table: PriceTable | undefined): string[] {
  return (table?.rows ?? []).map((r) => {
    const per = rowTerms(r);
    const notes = shownQualifiers(r).join(", ");
    return `- ${r.addOn ? "Add-on " : ""}${r.plan}: ${r.amount}${per ? ` ${per}` : ""}${notes ? ` (${notes})` : ""}`;
  });
}

// The judge's instruction, with the question, the reply and the site's text. Pure.
export function judgePrompt(input: Omit<JudgeInput, "deploymentId">): string {
  const facts = [
    ...factLines(input.keyFacts ?? []),
    ...(input.events ?? []).map((e) => `${e.url} states the date ${e.readAs || e.date}: "${e.line}"`),
  ];
  let site = [...facts, ...input.passages.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)].join("\n");
  if (site.length > MAX_SITE_TEXT) site = `${site.slice(0, MAX_SITE_TEXT)}…`;
  return [
    "You check a website chatbot's reply before it goes live. Judge it only against the site's text below.",
    'First work out the one thing the question asks about, and what the reply is about. Then reply with JSON only: {"verdict":"answers"|"partly"|"not-on-site"|"contradicts"|"off-topic"|"substituted"|"talks-about-sources","reason":"<at most 15 words, in English>"}.',
    '"answers": the reply answers the question from the site\'s text. Saying what the text doesn\'t state is fine when the text really doesn\'t state it (a starting price and "ask for a quote" when no exact price is listed).',
    '"partly": it answers in part, and leaves out something the question asks for that the site\'s text does state. Details the reply gives beyond the text are not "partly".',
    '"not-on-site": it doesn\'t answer: it says, in any words, that it doesn\'t know or that the site lacks it, and the text indeed lacks it. A reworded "we don\'t know" is not-on-site.',
    "\"contradicts\": it says something is missing, not listed, over, passed or unavailable while the site's text shows it (a price, steps, a contact, or a date on or after today), or it gives a different figure or date for the same thing than the text does. The text shows only part of the site: a figure, name or option the text doesn't mention at all is not a contradiction.",
    'A reply saying that our website, site or pages as a whole don\'t list or provide something is never "answers": judge that claim (contradicts when the text shows it, else not-on-site).',
    '"off-topic": it answers a different question, or about a different product, case or surface than the one asked.',
    '"substituted": it gives something real from the site about a related thing (a date for another event, a contact for another region or team, features when a price was asked, a neighbouring feature, a demo for a trial) and nothing on the thing asked. Saying the thing asked is missing does not make it "answers".',
    "A plan can have several prices: monthly and yearly billing, volume tiers, and rates for extras such as overage or add-ons. Two such prices of one plan never conflict, and a plan's overage rate is not its price. When a price table is given, a figure that matches a row for that plan is right.",
    '"talks-about-sources": instead of just answering, it talks about its own material ("the information we have", "the information provided", "the provided pages", "the available text", "the context"). Naming one of our pages ("Our pricing page lists…", "The page also shows…", "Our Pricing page doesn\'t list a price for 300 devices") is answering, never talks-about-sources: the chatbot is told to name the page.',
    'Say "contradicts" only when the reply states something the text states differently, or denies something the text states. Never for a detail the text doesn\'t mention.',
    `Today is ${DAY.format(input.today ?? new Date())}. A date without a year means its next occurrence on or after the page's own date.`,
    `Question: ${input.question}`,
    `Reply: ${input.answer}`,
    ...(input.priceTable?.rows.length ? [`Price table:\n${tableLines(input.priceTable).join("\n")}`] : []),
    `Site text:\n${site || "(none)"}`,
  ].join("\n");
}

// The judge's reply as a judgement, or undefined when it isn't one. Pure.
export function parseJudgement(text: string): { verdict: JudgeVerdict; reason: string } | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const j = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
    const verdict = typeof j.verdict === "string" ? j.verdict.trim().toLowerCase() : "";
    // The spike's words, should the model use them.
    const v = verdict === "yes" ? "answers" : verdict === "no" ? "not-on-site" : verdict;
    if (!isJudgeVerdict(v)) return undefined;
    const reason = typeof j.reason === "string" ? j.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { verdict: v, reason };
  } catch {
    return undefined;
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

// The pair's hashes: the question as the question log hashes it; the answer with the judge's
// version and the key-page facts it was judged against.
export function judgementKey(input: Pick<JudgeInput, "question" | "answer" | "keyFacts" | "events" | "priceTable">): {
  questionHash: string;
  answerHash: string;
} {
  const facts = [
    ...factLines(input.keyFacts ?? []),
    ...(input.events ?? []).map((e) => `${e.url} ${e.date}`),
    ...tableLines(input.priceTable),
  ]
    .sort()
    .join("\n");
  return { questionHash: questionHash(input.question), answerHash: sha(`${JUDGE_VERSION}\n${normalizeQuestion(input.answer)}\n${facts}`) };
}

// Asks the model, or reads the cached judgement. Never throws: "unavailable" when it can't ask.
export async function judgeAnswer(input: JudgeInput): Promise<Judgement> {
  const started = Date.now();
  const key = judgementKey(input);
  const cache = input.cache !== false;
  try {
    if (!cache) throw new Error("no cache");
    const [cached] = await db()
      .select({ verdict: judgements.verdict, reason: judgements.reason })
      .from(judgements)
      .where(
        and(
          eq(judgements.deploymentId, input.deploymentId),
          eq(judgements.questionHash, key.questionHash),
          eq(judgements.answerHash, key.answerHash),
        ),
      );
    if (cached && isJudgeVerdict(cached.verdict))
      return { verdict: cached.verdict, reason: cached.reason, cached: true, ms: Date.now() - started };
  } catch {
    // no cache: ask
  }
  try {
    const nuaKey = env().nuaKey;
    const zone = nuaZone(nuaKey);
    if (!zone) return { verdict: "unavailable", reason: "The account key names no zone." };
    const result = await predictChat({
      zone,
      nuaKey,
      body: { question: judgePrompt(input), user_id: "launchpad-judge", temperature: 0, max_tokens: 200 },
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    const judged = parseJudgement(result.text);
    if (!judged) return { verdict: "unavailable", reason: "The judge's reply couldn't be read.", ms: Date.now() - started };
    if (cache) {
      await db()
        .insert(judgements)
        .values({ deploymentId: input.deploymentId, ...key, verdict: judged.verdict, reason: judged.reason, model: result.model ?? null })
        .onConflictDoNothing()
        .catch(() => {});
    }
    return { ...judged, ms: Date.now() - started };
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? `no reply within ${JUDGE_TIMEOUT_MS / 1000} s` : String(err);
    return { verdict: "unavailable", reason: `The judge couldn't be asked: ${why}`.slice(0, 200), ms: Date.now() - started };
  }
}
