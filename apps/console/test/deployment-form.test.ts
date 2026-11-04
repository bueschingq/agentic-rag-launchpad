import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeploymentForm } from "../src/lib/deployment-form.ts";
import { composeSystemPrompt, searchConfigFor, searchConfigName } from "../src/lib/prompt.ts";
import { kbSlugFor, slugify, uniqueSlug } from "../src/lib/slug.ts";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const CUSTOMER = "2b7c1d0e-5f3a-4c2b-9d1e-0a1b2c3d4e5f";

describe("parseDeploymentForm", () => {
  it("reads the site, its origin and extra domains, deduplicated", () => {
    const parsed = parseDeploymentForm(
      form({
        customerId: CUSTOMER,
        name: " Main site ",
        siteUrl: "www.harborview.example/clinic",
        extraDomains: "https://staging.harborview.example\nhttps://www.harborview.example, http://localhost:4173",
        language: "",
        systemPrompt: "  Be kind.  ",
      }),
    );
    assert.deepEqual(parsed, {
      value: {
        customerId: CUSTOMER,
        name: "Main site",
        siteUrl: "https://www.harborview.example/clinic",
        domains: ["https://www.harborview.example", "https://staging.harborview.example", "http://localhost:4173"],
        language: null,
        systemPrompt: "Be kind.",
      },
    });
  });

  it("accepts auto and fixed languages", () => {
    const base = { customerId: CUSTOMER, name: "x", siteUrl: "https://a.example", systemPrompt: "p" };
    assert.equal((parseDeploymentForm(form({ ...base, language: "auto" })) as { value: { language: string } }).value.language, "auto");
    assert.equal((parseDeploymentForm(form({ ...base, language: "fr" })) as { value: { language: string } }).value.language, "fr");
  });

  it("names every field that is wrong", () => {
    const parsed = parseDeploymentForm(
      form({ customerId: "acme", name: "", siteUrl: "ftp://files.example", extraDomains: "not a url", language: "xx", systemPrompt: "" }),
    );
    assert.ok("errors" in parsed);
    assert.deepEqual(Object.keys(parsed.errors).sort(), ["customerId", "extraDomains", "language", "name", "siteUrl", "systemPrompt"]);
  });

  it("caps the prompt length", () => {
    const parsed = parseDeploymentForm(form({ customerId: CUSTOMER, name: "x", siteUrl: "a.example", systemPrompt: "x".repeat(4001) }));
    assert.ok("errors" in parsed && parsed.errors.systemPrompt);
  });
});

describe("composeSystemPrompt", () => {
  it("adds one language rule to the partner's prompt", () => {
    assert.equal(
      composeSystemPrompt(" Be brief. ", "es", null),
      "Be brief.\n\nAlways answer in Spanish, whatever language the question is in.",
    );
    assert.equal(composeSystemPrompt("Be brief.", "auto", null), "Be brief.\n\nAnswer in the language the question is asked in.");
  });

  it("builds the search configuration the spike verified", () => {
    const config = searchConfigFor("Be brief.", "de", null);
    assert.equal(config.citations, true);
    // 20 paragraphs since round 5: with 10, a key page's text was crowded out after the full sync.
    assert.equal(config.top_k, 20);
    assert.equal(
      (config.prompt as { system: string }).system,
      "Be brief.\n\nAlways answer in German, whatever language the question is in.",
    );
  });

  it("asks imported deployments, which have no saved prompt, with the KB's defaults", () => {
    assert.equal(searchConfigName({ systemPrompt: "Be brief.", searchConfig: "launchpad-default" }), "launchpad-default");
    assert.equal(searchConfigName({ systemPrompt: "", searchConfig: "launchpad-default" }), undefined);
  });
});

describe("slugs", () => {
  it("makes URL- and KB-safe slugs", () => {
    assert.equal(slugify("  Café Olé — Ünïcode & Co. "), "cafe-ole-unicode-co");
    assert.equal(kbSlugFor("harbor-view", "https://www.harborview.example/clinic"), "harbor-view-harborview-example");
    assert.equal(slugify("x".repeat(80)).length, 60);
  });

  it("adds a number until the slug is free, staying within the limit", () => {
    assert.equal(uniqueSlug("acme", new Set()), "acme");
    assert.equal(uniqueSlug("acme", new Set(["acme", "acme-2"])), "acme-3");
    const long = "a".repeat(60);
    assert.equal(uniqueSlug(long, new Set([long])), `${"a".repeat(58)}-2`);
  });
});
