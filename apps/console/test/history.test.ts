import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { historyActor, historyWhat, typedNear, WORDS } from "../src/lib/history.ts";

describe("History's who", () => {
  it("names the signed-in person, else the name typed in setup mode, marked (not verified) once", () => {
    assert.equal(historyActor("deployment.signoff", { name: "Dana (setup mode, not verified)" }, "Alex Admin"), "Alex Admin");
    assert.equal(
      historyActor("deployment.signoff", { name: "Release Verifier (setup mode, not verified)", verified: false }, null),
      "Release Verifier (setup mode, not verified)",
    );
    assert.equal(historyActor("deployment.validation.not-covered", { name: "Dana" }, null), "Dana (not verified)");
    assert.equal(historyActor("content.pin", { name: "Quinton (not verified)", verified: false }, null), "Quinton (not verified)");
    assert.equal(historyActor("content.key-pages", { name: " Sam " }, null), "Sam (not verified)");
  });

  it("falls back to the name typed in the same sitting for a setup-mode entry that recorded none", () => {
    assert.equal(historyActor("deployment.widget", {}, null, "Dana"), "Dana (not verified)");
    assert.equal(historyActor("deployment.widget", {}, null, "Dana (setup mode, not verified)"), "Dana (setup mode, not verified)");
    assert.equal(historyActor("deployment.widget", {}, null), "Someone in setup mode");
    // A name on the entry itself wins.
    assert.equal(historyActor("deployment.starters", { name: "Sam" }, null, "Dana"), "Sam (not verified)");
  });

  it("takes the name typed nearest in time, before or after, within two hours (round 5, 7d)", () => {
    const at = (hhmm: string, day = "2026-10-31") => new Date(`${day}T${hhmm}:00Z`);
    const typed = [
      // The round-4 signer, the day before.
      { at: at("09:00", "2026-10-30"), name: "Quinn Junior (UX r4) (setup mode, not verified)" },
      // Typed for Add, a few minutes after Read the pages again.
      { at: at("05:21"), name: "Sam Sales-Engineer" },
      { at: at("05:36"), name: "Sam Sales-Engineer (setup mode, not verified)" },
    ];
    // Bring up to date's "Read the pages again", before any name was typed that morning.
    assert.equal(typedNear(typed, at("05:19")), "Sam Sales-Engineer");
    assert.equal(historyActor("content.reread", {}, null, typedNear(typed, at("05:19"))), "Sam Sales-Engineer (not verified)");
    // The prompt saved between Add and the sign-off: the nearer of the two.
    assert.equal(typedNear(typed, at("05:33")), "Sam Sales-Engineer (setup mode, not verified)");
    // Never the round-4 signer's name, a day old: nobody typed one in this sitting.
    assert.equal(typedNear(typed, at("02:00")), undefined);
    assert.equal(typedNear([{ at: at("09:00", "2026-10-30"), name: "Quinn Junior (UX r4)" }], at("05:30")), undefined);
    assert.equal(typedNear([{ at: at("05:00"), name: "  " }], at("05:01")), undefined);
  });

  it("doesn't take the deployment's own name for a person, and calls the worker's runs the automatic re-run", () => {
    assert.equal(historyActor("deployment.create", { name: "Main site" }, null), "Someone in setup mode");
    assert.equal(historyActor("deployment.validate", { auto: "sync-finished", passed: true }, null), "The automatic re-run");
    assert.equal(
      historyActor("deployment.starters.removed", { auto: "sync-finished", name: "the automatic re-run" }, null, "Dana"),
      "The automatic re-run",
    );
    assert.equal(historyActor("deployment.install-check", { via: "share" }, null), "Someone with the install guide link");
  });
});

describe("History's what", () => {
  it("says the new actions in words", () => {
    assert.equal(
      historyWhat("deployment.starters.removed", { question: "How do I contact sales?", reason: "no answer", auto: "sync-finished" }),
      "took a starter that stopped answering off the chat: “How do I contact sales?” (no answer)",
    );
    assert.equal(
      historyWhat("content.key-pages", {
        added: ["https://x.example/pricing", "https://x.example/contact"],
        dropped: ["https://x.example/a"],
      }),
      "added the site's key pages to the sync: 2 pages join, 1 page at the end of the budget leaves",
    );
    // Round 5: Add's line says what it proposed until its sync finishes, then what joined and left.
    const proposed = {
      added: ["https://x.example/purchase.aspx", "https://x.example/quote"],
      joined: ["https://x.example/a"],
      dropped: ["https://x.example/b", "https://x.example/c"],
    };
    assert.equal(
      historyWhat("content.key-pages", { ...proposed, before: [] }),
      "added the site's key pages to the sync: 2 key pages to join with 1 page more, 2 pages at the end of the budget to leave once the sync finishes",
    );
    assert.equal(
      historyWhat("content.key-pages", { added: [], joined: [], dropped: [], proposed, settled: "2026-10-31T05:26:00Z" }),
      "added the site's key pages to the sync: no key page joined",
    );
    assert.equal(
      historyWhat("content.key-pages", { ...proposed, proposed, settled: "2026-10-31T05:26:00Z" }),
      "added the site's key pages to the sync: 2 key pages joined, with 1 page more; 2 pages at the end of the budget left",
    );
    assert.equal(
      historyWhat("content.retracted", { pages: ["https://x.example/2016-prices"], auto: "upgrade" }),
      "took pages left out by hand out of the chat: /2016-prices",
    );
    assert.equal(historyActor("content.retracted", { pages: [], auto: "upgrade" }, null), "The upgrade");
    assert.equal(
      historyWhat("content.reread", { pages: 221, tonight: true }),
      "had the pages read again in tonight's batch, from Fleet (221 pages)",
    );
    // Item 6: the rollout's line, and who applied it.
    const rollout = { from: 0, to: 1, changes: "…", recheck: { total: 14, unchanged: 12, better: 2 } };
    assert.equal(
      historyWhat("deployment.rules.applied", rollout),
      "applied the answering rules v1 after a re-check: 14 of 14 unchanged or better",
    );
    assert.equal(historyActor("deployment.rules.applied", rollout, null, "Dana"), "The automatic re-check");
    assert.equal(historyActor("deployment.rules.applied", { from: 0, to: 1, name: "Dana", verified: false }, null), "Dana (not verified)");
    assert.equal(
      historyWhat("deployment.install-check", { origin: "https://x.example", url: "https://x.example/" }),
      "found the snippet with Check installation on https://x.example/",
    );
    assert.equal(
      historyWhat("deployment.validate", { auto: "half-answerable", passed: false }),
      "ran validation once half the pages were answerable: didn't pass",
    );
    assert.equal(
      historyWhat("deployment.validation.ask-again", { question: "How much is it?", answered: true, auto: "pages-added" }),
      "asked a question again with the pages added: “How much is it?”, answered",
    );
    assert.equal(
      historyWhat("deployment.validation.not-covered", { question: "Can I buy online?", reason: "Sold by dealers" }),
      "marked a question as not covered by the site: “Can I buy online?”",
    );
    assert.equal(
      historyWhat("deployment.signoff", { replaces: "2026-10-30T10:00:00.000Z" }),
      "signed it off, for the changes since the last sign-off",
    );
  });

  it("tells adding a page by hand from keeping one despite a rule, and from a rule asking first", () => {
    assert.equal(historyWhat("content.pin", { added: ["https://x.example/contact"], refused: [] }), "added /contact by hand");
    assert.equal(
      historyWhat("content.pin", {
        added: ["https://x.example/blog/cost"],
        kept: [
          {
            url: "https://x.example/blog/cost",
            rule: "This page states a price and was published 11 Oct 2016.",
            reason: "The client confirmed it",
          },
        ],
        name: "Dana",
        verified: false,
      }),
      "kept /blog/cost by hand despite a stale price: “The client confirmed it”",
    );
    assert.equal(
      historyWhat("content.pin", { added: [], refused: [], needsReason: [{ url: "https://x.example/old", rule: "Published 2019." }] }),
      "tried to add 1 page by hand: a date or stale-price rule asks for a reason first",
    );
    assert.equal(
      historyWhat("deployment.validation.add-pages", {
        question: "How do I clean walls?",
        urls: ["https://x.example/a"],
        kept: "Still right",
      }),
      "added pages for a question with no answer: “How do I clean walls?”, kept anyway: “Still right”",
    );
  });

  // Every audit action the console and the worker write for a deployment has words of its own, so
  // History never shows a bare action name. A new action fails here until it's added to WORDS.
  it("has words for every deployment and content action in the code", () => {
    const roots = [join(import.meta.dirname, "../src"), join(import.meta.dirname, "../../worker/src")];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const root of roots) walk(root);
    const actions = new Set(
      files.flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/["'`]((?:deployment|content)\.[a-z][a-z0-9.-]*[a-z0-9])["'`]/g)].map((m) => m[1]!),
      ),
    );
    assert.ok(actions.has("deployment.starters.removed") && actions.has("content.key-pages"));
    assert.deepEqual(
      [...actions].filter((a) => !WORDS[a]),
      [],
    );
  });
});
