// Keeps today's date in each deployment's saved prompt, so answers can tell past events from
// coming ones (a 2025 webinar is never "the next one"). The widget asks with the saved search
// configuration straight from the visitor's browser, so the date lives there.
//
// Runs hourly and writes only when something changed, so each KB gets the new date within an
// hour of midnight UTC, even after the worker was down. It edits only what the console adds: the
// date paragraph of the system prompt, and the console's user prompt and page titles (the
// answering rules on language and products, apps/console/src/lib/prompt.ts), which deployments
// saved before them get this way. A prompt someone changed in the Agentic RAG dashboard keeps
// that change, and a user prompt set there is left alone.

import { deployments } from "@launchpad/db";
import type { AskConfig } from "@launchpad/par-client";
import { intentConfigName, type LanguageSetting, languageSetting, withToday } from "@launchpad/theme";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { eventsForPrompt } from "../../../console/src/lib/content.ts";
import {
  composeUserPrompt,
  eventsParagraph,
  isConsoleUserPrompt,
  PAGE_TITLES,
  pricesParagraph,
  RAG_STRATEGIES,
  TOP_K,
  withEventsParagraph,
  withPricesParagraph,
} from "../../../console/src/lib/prompt.ts";
import { promptPrices } from "../../../console/src/lib/validation-rules.ts";
import { type JobContext, managerClient } from "../context.ts";

type Strategy = { name?: unknown } & Record<string, unknown>;

// The saved configuration brought up to date, or undefined when it's already current (or has
// no system prompt to date). With `language`, also the console's current user prompt, page titles
// in the retrieval and the number of paragraphs it retrieves (raised to 20 in round 5), unless the
// user prompt there isn't the console's. With `events` (the events configuration's paragraph,
// prompt.ts eventsParagraph), also today's list of upcoming events, where the prompt already lists
// them (answering rules 4): data, refreshed with the date, never a rule added unchecked. With `prices`
// (the price configuration's paragraph, prompt.ts pricesParagraph), today's price list likewise, where
// the prompt already has one: a re-read table reaches it the same day.
export function datedConfig(
  config: AskConfig & { query?: unknown },
  today: Date,
  language?: LanguageSetting,
  events?: string,
  prices?: string,
): AskConfig | undefined {
  const { query: _query, ...rest } = config;
  // AskConfig keeps only its index signature through Omit, so the prompt's shape is restated.
  const prompt = rest.prompt as string | { system?: string; user?: string } | undefined;
  const system = typeof prompt === "string" ? prompt : prompt?.system;
  if (!system) return undefined;
  const listed = events === undefined ? system : withEventsParagraph(system, events);
  const dated = withToday(prices === undefined ? listed : withPricesParagraph(listed, prices), today);
  const savedUser = typeof prompt === "object" ? prompt.user : undefined;
  const ours = language !== undefined && (savedUser === undefined || isConsoleUserPrompt(savedUser));
  const user = ours ? composeUserPrompt(language) : savedUser;
  const saved = (rest.rag_strategies ?? []) as Strategy[];
  // Only on the console's own retrieval (neighbouring paragraphs); anything else was chosen in the dashboard.
  const titles = ours && !saved.some((s) => s.name === "hierarchy") && saved.every((s) => s.name === "neighbouring_paragraphs");
  // Fewer paragraphs than the console retrieves: raised (a larger number set in the dashboard stays).
  const topK = ours && typeof rest.top_k === "number" && rest.top_k < TOP_K;
  if (dated === system && user === savedUser && !titles && !topK) return undefined;
  return {
    ...rest,
    ...(titles && { rag_strategies: saved.length ? [...saved, PAGE_TITLES] : RAG_STRATEGIES }),
    ...(topK && { top_k: TOP_K }),
    prompt:
      typeof prompt === "string" && !user ? dated : { ...(typeof prompt === "object" && prompt), system: dated, ...(user && { user }) },
  };
}

// Round 5 (answering rules, item 6): once a day, and only the date. The rules (user prompt, page
// titles, paragraphs retrieved) reach a deployment only through jobs/rules-rollout.ts, after its
// own re-check: the hourly push that also rewrote them flipped live answers with no notice. The
// date is refreshed in the default configuration and each intent configuration beside it, and the
// events configuration's list of upcoming events with it (round 6, recheck 2: the model had to sort
// and place dates from retrieved fragments, and teamwork.com's chat led with 5 Nov over 4 Nov).
export async function refreshPromptDates(ctx: JobContext, today: Date): Promise<void> {
  const rows = await ctx.db
    .select({
      id: deployments.id,
      zone: deployments.zone,
      kbId: deployments.kbId,
      searchConfig: deployments.searchConfig,
      priceTable: deployments.priceTable,
      priceTableConfirmation: deployments.priceTableConfirmation,
    })
    .from(deployments)
    .where(and(inArray(deployments.status, ["live", "paused"]), isNotNull(deployments.kbId), ne(deployments.systemPrompt, "")));
  let updated = 0;
  for (const d of rows) {
    try {
      const kb = await managerClient(ctx, d);
      if (!kb) continue;
      const configs = await kb.listSearchConfigs();
      for (const [name, saved] of Object.entries(configs)) {
        if (saved.kind !== "ask" || (name !== d.searchConfig && !name.startsWith(`${d.searchConfig}-`))) continue;
        // No language: the date paragraph (and the events list) only, never the rules.
        const events =
          name === intentConfigName(d.searchConfig, "events") ? eventsParagraph(await eventsForPrompt(d.id, today)) : undefined;
        const prices = name === intentConfigName(d.searchConfig, "price") ? pricesParagraph(promptPrices(d)) : undefined;
        const config = datedConfig(saved.config, today, undefined, events, prices);
        if (!config) continue;
        await kb.saveSearchConfig(name, config);
        updated++;
      }
    } catch (err) {
      ctx.log(`prompt date failed for deployment ${d.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (updated) ctx.log(`prompt date: ${updated} saved configurations given today's date`);
}

// After a sync: the events configuration's list and date, from what's in the chat now, so a new
// deployment's chat doesn't say "none is dated today or later" until the nightly refresh (round 7).
// Only the list and the date, as above. A failure waits for the nightly one.
export async function refreshEventsList(ctx: JobContext, deploymentId: string, today: Date): Promise<void> {
  try {
    const [d] = await ctx.db
      .select({ id: deployments.id, zone: deployments.zone, kbId: deployments.kbId, searchConfig: deployments.searchConfig })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), isNotNull(deployments.kbId), ne(deployments.systemPrompt, "")));
    const kb = d && (await managerClient(ctx, d));
    if (!d || !kb) return;
    const name = intentConfigName(d.searchConfig, "events");
    const saved = (await kb.listSearchConfigs())[name];
    if (saved?.kind !== "ask") return;
    const config = datedConfig(saved.config, today, undefined, eventsParagraph(await eventsForPrompt(d.id, today)));
    if (config) await kb.saveSearchConfig(name, config);
  } catch (err) {
    ctx.log(`events list failed for deployment ${deploymentId}: ${err instanceof Error ? err.message : err}`);
  }
}

// Before round 5: the hourly push that also brought the rules to every deployment. Kept for the
// record and its tests; nothing schedules it.
export async function refreshPromptDatesAndRules(ctx: JobContext, today: Date): Promise<void> {
  // Deployments whose prompt the console saved (imported ones ask with the KB's own defaults).
  const rows = await ctx.db
    .select({
      id: deployments.id,
      zone: deployments.zone,
      kbId: deployments.kbId,
      searchConfig: deployments.searchConfig,
      language: deployments.language,
    })
    .from(deployments)
    .where(and(inArray(deployments.status, ["live", "paused"]), isNotNull(deployments.kbId), ne(deployments.systemPrompt, "")));
  let updated = 0;
  for (const d of rows) {
    try {
      const kb = await managerClient(ctx, d);
      if (!kb) continue;
      const saved = (await kb.listSearchConfigs())[d.searchConfig];
      if (saved?.kind !== "ask") continue;
      const config = datedConfig(saved.config, today, languageSetting(d.language));
      if (!config) continue;
      await kb.saveSearchConfig(d.searchConfig, config);
      updated++;
    } catch (err) {
      ctx.log(`prompt date failed for deployment ${d.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (updated) ctx.log(`prompt date: ${updated} of ${rows.length} saved configurations brought up to date`);
}
