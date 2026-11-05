import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PriceRow } from "@launchpad/db";
import { todayRule } from "@launchpad/theme";
import { composeUserPrompt, pricesParagraph, RAG_STRATEGIES, TOP_K } from "../../console/src/lib/prompt.ts";
import { datedConfig } from "../src/jobs/prompt-date.ts";

const friday = new Date("2026-10-30T23:00:00Z");
const saturday = new Date("2026-10-31T00:07:00Z");

describe("today's date in the saved prompt", () => {
  const saved = {
    query: "",
    citations: true,
    top_k: 10,
    prompt: { system: `Be brief.\n\nAlways answer in English, whatever language the question is in.\n\n${todayRule(friday)}` },
  };

  it("replaces the date paragraph and keeps everything else", () => {
    const config = datedConfig(saved, saturday);
    assert.ok(config);
    assert.equal(
      (config.prompt as { system: string }).system,
      `Be brief.\n\nAlways answer in English, whatever language the question is in.\n\n${todayRule(saturday)}`,
    );
    assert.equal(config.top_k, 10);
    assert.equal("query" in config, false);
  });

  it("writes nothing when the date is current, or there's no prompt", () => {
    assert.equal(datedConfig(saved, friday), undefined);
    assert.equal(datedConfig({ citations: true }, saturday), undefined);
  });

  it("dates a prompt saved before the date existed, and a plain-string prompt", () => {
    const old = datedConfig({ prompt: { system: "Be brief." } }, saturday);
    assert.ok(old);
    assert.equal((old.prompt as { system: string }).system, `Be brief.\n\n${todayRule(saturday)}`);
    assert.equal(datedConfig({ prompt: "Be brief." }, saturday)?.prompt, `Be brief.\n\n${todayRule(saturday)}`);
  });
});

describe("the console's answering rules in the saved configuration", () => {
  const before = {
    query: "",
    citations: true,
    top_k: 10,
    rag_strategies: [{ name: "neighbouring_paragraphs", before: 1, after: 1 }],
    prompt: { system: `Be brief.\n\nAnswer in the language the question is asked in.\n\n${todayRule(friday)}` },
  };

  it("gives deployments saved before them the user prompt and page titles, keeping the rest", () => {
    const config = datedConfig(before, friday, "auto");
    assert.ok(config);
    const prompt = config.prompt as { system: string; user: string };
    assert.equal(prompt.system, before.prompt.system);
    assert.equal(prompt.user, composeUserPrompt("auto"));
    assert.deepEqual(
      (config.rag_strategies as { name: string }[]).map((s) => s.name),
      ["neighbouring_paragraphs", "hierarchy"],
    );
    // Round 5: 20 paragraphs, not 10.
    assert.equal(config.top_k, TOP_K);
    assert.equal(TOP_K, 20);
    // Then it's current: nothing to write.
    assert.equal(datedConfig({ ...before, ...config }, friday, "auto"), undefined);
  });

  it("follows a language change, and leaves a user prompt set in the dashboard alone", () => {
    const current = {
      ...before,
      top_k: TOP_K,
      prompt: { system: before.prompt.system, user: composeUserPrompt("auto") },
      rag_strategies: RAG_STRATEGIES,
    };
    const german = datedConfig(current, friday, "de");
    assert.ok(german);
    assert.equal((german.prompt as { user: string }).user, composeUserPrompt("de"));
    const own = { ...before, prompt: { system: before.prompt.system, user: "Context: {context}\nQ: {question}" } };
    assert.equal(datedConfig(own, friday, "auto"), undefined);
    // Retrieval someone chose in the dashboard stays as it is.
    assert.deepEqual(datedConfig({ ...before, rag_strategies: [{ name: "full_resource" }] }, friday, "auto")?.rag_strategies, [
      { name: "full_resource" },
    ]);
  });
});

// Fix cycle 7c: a re-read price table reaches the price configuration's prompt with the date.
describe("the price list refreshes with the date", () => {
  const row = (plan: string, value: number): PriceRow => ({
    plan,
    amount: `$${value}`,
    value,
    period: "month",
    url: "https://x.example/p",
    line: `${plan} $${value}`,
  });
  const system = (rows: PriceRow[]) => `Rules.\n\n${pricesParagraph(rows)}\n\n${todayRule(new Date("2026-11-01T00:00:00Z"))}`;
  const today = new Date("2026-11-02T00:00:00Z");
  const saved = (text: string) =>
    datedConfig({ prompt: { system: text } }, today, undefined, undefined, pricesParagraph([row("Basic", 29)]));
  const out = (c: ReturnType<typeof saved>) => (c!.prompt as { system: string }).system;

  it("replaces the list in a prompt that has one", () => {
    const text = out(saved(system([row("Basic", 19)])));
    assert.match(text, /\$29/);
    assert.doesNotMatch(text, /\$19/);
  });
  it("adds no list to a prompt without one: it's data, not a rule", () => {
    assert.doesNotMatch(out(saved("Rules.")), /\$29/);
  });
});
