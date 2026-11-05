import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slugFor as workerSlug } from "../../worker/src/jobs/content.ts";
import {
  inChatCounts,
  keyPagesState,
  lastSyncLabel,
  matchNote,
  rereadNote,
  searchWords,
  slugFor,
  syncEstimate,
  syncedAnswerNote,
  thinContactPages,
  typedAddresses,
  unusedKeyReason,
} from "../src/lib/content.ts";
import { parseContentForm, parsePlanForm, parseSitemapAddress } from "../src/lib/content-form.ts";

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [name, value] of Object.entries(fields)) for (const v of [value].flat()) f.append(name, v);
  return f;
};

describe("New deployment's plan fields", () => {
  it("asks to keep a language only when the plan showed languages to choose from", () => {
    // kemptechnologies.com in round 3: a plan with no pages, so no languages, and the error named a
    // control that wasn't on the page.
    const empty = parsePlanForm(form({ planShown: "1", pageBudget: "200" }));
    assert.ok("value" in empty && empty.value.languages.length === 0);
    const shown = parsePlanForm(form({ planShown: "1", languagesShown: "1", pageBudget: "200" }));
    assert.ok("errors" in shown && shown.errors.languages === "Keep at least one language.");
  });

  it("takes a sitemap address ending in .xml, and says how to fix another", () => {
    assert.deepEqual(parseSitemapAddress(""), {});
    assert.deepEqual(parseSitemapAddress("kemptechnologies.com/sitemap.xml"), { sitemap: "https://kemptechnologies.com/sitemap.xml" });
    assert.match(parseSitemapAddress("https://www.example.com/sitemap").error!, /ending in \.xml/);
    const parsed = parsePlanForm(form({ pageBudget: "200", sitemap: "https://kemptechnologies.com/sitemap.xml" }));
    assert.ok("value" in parsed && parsed.value.sitemap === "https://kemptechnologies.com/sitemap.xml");
    const settings = parseContentForm(form({ sitemap: "https://www.client.com/sitemaps/en.xml" }), "https://www.client.com/");
    assert.ok("value" in settings && settings.value.sitemap === "https://www.client.com/sitemaps/en.xml");
    const bad = parseContentForm(form({ sitemap: "not an address" }), "https://www.client.com/");
    assert.ok("errors" in bad && bad.errors.sitemap);
  });
});

describe("the sync's time left", () => {
  const first = { lastSyncedAt: null, lastJobStatus: "running" };

  it("counts this deployment's pages and those loaded before its last, at the worker's pace", () => {
    // 150 waiting, two other first syncs with 200 each ahead in turn: 450 pages at 60 a minute.
    const busy = syncEstimate(first, { queued: 150, processing: 10 }, { ahead: 2, beforeLast: 300, recent: 600 });
    assert.deepEqual(busy, { pagesLeft: 160, minutes: 10, first: true, text: "about 10 min left" });
    // A slow day: 20 pages loaded in the last 3 minutes reads as 10 a minute (never slower than that).
    assert.equal(syncEstimate(first, { queued: 50, processing: 0 }, { ahead: 0, beforeLast: 0, recent: 20 }).minutes, 7);
    // Only indexing left, or the pages not listed yet: said plainly, not as a minute count.
    assert.equal(
      syncEstimate(first, { queued: 0, processing: 5 }, { ahead: 0, beforeLast: 0, recent: 0 }).text,
      "almost done: Agentic RAG is indexing the last 5 pages",
    );
    assert.equal(
      syncEstimate({ ...first, lastJobStatus: "queued" }, { queued: 0, processing: 0 }, { ahead: 0, beforeLast: 0, recent: 0 }).text,
      "reading the site's sitemaps",
    );
    assert.equal(
      syncEstimate({ ...first, lastSyncedAt: new Date() }, { queued: 0, processing: 0 }, { ahead: 0, beforeLast: 0, recent: 0 }).text,
      "finishing",
    );
  });

  it("never shows the same 'about N min' for longer than N minutes", () => {
    // telerik.com's tail in round 4: one page at a time, "about 3 min left" from 21:15 to 21:35.
    const tail = { queued: 1, processing: 0 };
    const queue = { ahead: 0, beforeLast: 0, recent: 0 };
    const at = Date.parse("2026-10-30T21:15:00Z");
    assert.equal(syncEstimate(first, tail, queue).text, "about 3 min left");
    assert.equal(syncEstimate(first, tail, queue, { minutes: 3, since: at }, at + 2 * 60_000).text, "about 3 min left");
    assert.equal(
      syncEstimate(first, tail, queue, { minutes: 3, since: at }, at + 4 * 60_000).text,
      "taking longer than the 3 min estimated 4 min ago",
    );
    // A new count is shown afresh: it was first shown with another number.
    assert.equal(
      syncEstimate(first, { queued: 200, processing: 0 }, queue, { minutes: 3, since: at }, at + 20 * 60_000).text,
      "about 6 min left",
    );
  });

  it("says a first sync is running, not 'Never'", () => {
    const ago = () => "5 min ago";
    assert.equal(lastSyncLabel({ lastJobStatus: "running", lastSyncedAt: null }, ago), "First sync running");
    assert.equal(lastSyncLabel({ lastJobStatus: "queued", lastSyncedAt: null }, ago), "First sync running");
    assert.equal(lastSyncLabel({ lastJobStatus: "running", lastSyncedAt: new Date() }, ago), "Syncing now (last 5 min ago)");
    assert.equal(lastSyncLabel({ lastJobStatus: "ok", lastSyncedAt: new Date() }, ago), "5 min ago");
    assert.equal(lastSyncLabel(undefined, ago), "Never");
  });
});

describe("a page added by hand", () => {
  it("gets the same Knowledge Box slug as the sync gives it", () => {
    for (const url of [
      "https://www.crayola.com/stain-tips/regular-crayons-on-painted-walls-stain-tip",
      "https://WWW.Example.com/a/?gclid=1#x",
      "https://a.example/p?lang=es",
    ]) {
      assert.equal(slugFor(url), workerSlug(url), url);
    }
  });
});

describe("key pages that couldn't be used, and pages already synced", () => {
  it("says why a key page couldn't be used, with what to do", () => {
    assert.equal(
      unusedKeyReason("contact", "https://www.crayola.com/support/contact-us", "Too little text to answer from (3 words).", "skipped"),
      "/support/contact-us has almost no text (3 words): the chat can't answer from it. Put the contact details in Handoff, or add a page that states them.",
    );
    assert.match(
      unusedKeyReason("faq", "https://www.crayola.com/faqs/detail-faq", "The site answered 404.", "failed")!,
      /isn't on the site any more \(404\)/,
    );
    assert.match(
      unusedKeyReason(
        "trial",
        "https://x.example/try-now/sandbox/invalid-token",
        'An error page ("Your Token is Invalid"), with nothing to answer from.',
        "skipped",
      )!,
      /is an error page: \("Your Token is Invalid"\)/,
    );
    // A duplicate's canonical is synced in its place: nothing to report.
    assert.equal(
      unusedKeyReason("buy", "https://x.example/buy", "Duplicate of https://x.example/shop, which is synced instead.", "skipped"),
      undefined,
    );
  });

  it("says when the page that should answer is already in the sync", () => {
    const note = syncedAnswerNote([
      { url: "https://www.telerik.com/purchase.aspx", title: "Telerik Pricing", inSync: true, intent: "buy", keyPage: true },
      { url: "https://www.telerik.com/kendo-react-ui/pricing", inSync: true },
    ]);
    assert.match(
      note!,
      /^"Telerik Pricing" \(\/purchase\.aspx\), the page most likely to answer, is already in the sync, as the site's buying page/,
    );
    assert.match(note!, /Adding pages won't help/);
    assert.equal(syncedAnswerNote([{ url: "https://x.example/a", inSync: false }]), undefined);
    // A near miss isn't the page most likely to answer.
    assert.equal(syncedAnswerNote([{ url: "https://x.example/a", inSync: true, match: "near" }]), undefined);
  });
});

describe("round 5: the pages panel's search (item 2)", () => {
  it("starts Find a page with the question's telling words, so the client's own word is one edit", () => {
    assert.equal(searchWords("How do I get slime out of carpet?"), "slime carpet");
    assert.equal(searchWords("How do I get crayon off a painted wall?"), "crayon painted wall");
  });

  it("says what a near miss holds and lacks, and that a page was found by its text", () => {
    assert.equal(
      matchNote({
        url: "https://www.crayola.com/stain-tips/goo-on-carpet-stain-tip",
        inSync: true,
        match: "near",
        matched: ["carpet"],
        missing: ["slime"],
      }),
      "Near miss: has carpet, not slime.",
    );
    assert.equal(matchNote({ url: "https://x.example/a", inSync: true, match: "text" }), "Found in the page's text.");
    assert.equal(matchNote({ url: "https://x.example/a", inSync: true, match: "address" }), undefined);
  });
});

describe("round 5: pages being read again stay answerable (7c)", () => {
  it("counts a page waiting or processing with an indexed copy as answerable, never 0 of N on a serving chat", () => {
    const { counts, rereading } = inChatCounts([
      { status: "queued", n: 227, inChat: 227 },
      { status: "processing", n: 3, inChat: 1 },
      { status: "skipped", n: 12, inChat: 0 },
    ]);
    assert.deepEqual(counts, { queued: 0, processing: 2, indexed: 228, skipped: 12, failed: 0, removed: 0 });
    assert.equal(rereading, 228);
    assert.equal(rereadNote({ rereading }), "228 pages being read again; the chat keeps answering from the current copy.");
    assert.equal(rereadNote({ rereading: 0 }), undefined);
    // A first sync's waiting pages aren't in the chat yet.
    assert.deepEqual(inChatCounts([{ status: "queued", n: 50, inChat: 0 }]).counts.queued, 50);
  });
});

describe("round 5: Add during a running re-read (7b)", () => {
  const keysNow = [
    { url: "https://www.telerik.com/purchase.aspx", status: "queued" },
    { url: "https://www.telerik.com/contact", status: "indexed" },
  ];
  const added = {
    added: ["https://www.telerik.com/purchase.aspx", "https://www.telerik.com/contact"],
    dropped: ["https://www.telerik.com/x"],
  };

  it("isn't done while its own sync runs, or before the worker records what joined", () => {
    const state = keyPagesState({ ...added, before: [] }, keysNow, false);
    assert.equal(state.settled, false);
    assert.deepEqual(state.waiting, ["https://www.telerik.com/purchase.aspx"]);
  });

  it("is done once settled, with what actually joined and left", () => {
    const state = keyPagesState(
      {
        added: ["https://www.telerik.com/contact"],
        joined: [],
        dropped: [],
        proposed: added,
        settled: "2026-10-31T05:30:00.000Z",
      },
      [{ url: "https://www.telerik.com/purchase.aspx", status: "skipped" }, keysNow[1]!],
      false,
    );
    assert.equal(state.settled, true);
    assert.deepEqual(state.added, ["https://www.telerik.com/contact"]);
    assert.deepEqual(state.unusable, ["https://www.telerik.com/purchase.aspx"]);
    // An entry from before Add recorded what was in the sync: done once no sync runs.
    assert.equal(keyPagesState(added, keysNow, false).settled, true);
    assert.equal(keyPagesState(added, keysNow, true).settled, false);
  });
});

describe("round 6 fixes: Find a page and thin contact pages", () => {
  it("offers an address typed in, whether or not the sitemap read has it (teamleader.eu's /fr/prix)", () => {
    assert.deepEqual(typedAddresses("https://www.teamleader.eu/fr/prix", "https://www.teamleader.eu/"), [
      "https://www.teamleader.eu/fr/prix",
    ]);
    assert.deepEqual(typedAddresses("fr/contact", "https://www.teamleader.eu/"), ["https://www.teamleader.eu/fr/contact"]);
    assert.deepEqual(typedAddresses("Is support 24/7? and/or by phone", "https://www.teamleader.eu/"), []);
    assert.deepEqual(typedAddresses("https://other.example/fr/prix", "https://www.teamleader.eu/"), []);
  });

  it("lists a contact key page with no phone or email as too thin", () => {
    const thin = thinContactPages([
      {
        url: "https://www.teamleader.eu/fr/contact",
        title: "Contact",
        keyIntent: "contact",
        status: "indexed",
        facts: { contacts: [{ kind: "form", value: "https://www.teamleader.eu/fr/contact", line: "Contact" }] },
      },
      {
        url: "https://www.teamleader.eu/es/servicio-postventa",
        title: null,
        keyIntent: "contact",
        status: "indexed",
        facts: { contacts: [{ kind: "phone", value: "+34 911 23 27 54", line: "" }] },
      },
    ]);
    assert.deepEqual(
      thin.map((k) => k.url),
      ["https://www.teamleader.eu/fr/contact"],
    );
    assert.match(thin[0]!.why, /is a form with no phone number or email address/);
  });
});
