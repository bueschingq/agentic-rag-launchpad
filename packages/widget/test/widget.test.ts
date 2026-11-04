import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicTokenResponse } from "@launchpad/theme";
import { originRefused, StatusCheck, TokenSession } from "../src/session.ts";
import { safeHref, sourcesFor } from "../src/sources.ts";

const token = (n: number, expiresIn = 900): PublicTokenResponse => ({
  token: `t${n}`,
  expiresIn,
  expiresAt: "2000-01-01T00:00:00Z", // deliberately wrong: the session must not trust the visitor's clock against it
  askUrl: "https://z.dp.progress.cloud/api/v1/kb/k/ask",
});

describe("TokenSession", () => {
  it("reuses a token until shortly before it expires", async () => {
    let now = 0;
    let fetched = 0;
    const session = new TokenSession(
      async () => token(++fetched),
      () => now,
    );
    assert.equal((await session.get()).token, "t1");
    now = 869_000; // 900 s TTL minus the 30 s margin, minus 1 s
    assert.equal((await session.get()).token, "t1");
    now = 871_000;
    assert.equal((await session.get()).token, "t2");
  });

  it("shares one refresh between concurrent questions", async () => {
    let fetched = 0;
    const session = new TokenSession(async () => token(++fetched));
    const [a, b] = await Promise.all([session.get(), session.get()]);
    assert.equal(fetched, 1);
    assert.equal(a.token, b.token);
  });

  it("fetches a new token after invalidate()", async () => {
    let fetched = 0;
    const session = new TokenSession(async () => token(++fetched));
    await session.get();
    session.invalidate();
    assert.equal((await session.get()).token, "t2");
  });

  it("retries after a failed fetch instead of caching the failure", async () => {
    let calls = 0;
    const session = new TokenSession(async () => {
      calls += 1;
      if (calls === 1) throw new Error("console down");
      return token(calls);
    });
    await assert.rejects(session.get(), /console down/);
    assert.equal((await session.get()).token, "t2");
  });
});

describe("StatusCheck", () => {
  it("asks the console again only when its last word is over 30 seconds old", async () => {
    let now = 0;
    const answers = [false];
    let asked = 0;
    const status = new StatusCheck(
      true,
      async () => {
        asked += 1;
        return answers.shift() ?? true;
      },
      () => now,
    );
    assert.equal(await status.online(), true);
    now = 30_000;
    assert.equal(await status.online(), true);
    assert.equal(asked, 0);
    now = 30_001;
    assert.equal(await status.online(), false, "paused");
    now = 45_000;
    assert.equal(await status.online(), false, "cached");
    assert.equal(asked, 1);
    // Showing the offline message, it asks sooner: Resume reaches a chat that's already open.
    assert.equal(await status.online(5_000), true, "resumed");
    assert.equal(asked, 2);
  });

  it("keeps the chat going when the check itself fails", async () => {
    let now = 0;
    const status = new StatusCheck(
      true,
      () => Promise.reject(new Error("offline network")),
      () => now,
    );
    now = 60_000;
    assert.equal(await status.online(), true);
  });
});

describe("originRefused", () => {
  const ask = "https://z.dp.progress.cloud/api/v1/kb/k/ask";

  it("tells Agentic RAG turning the origin away from a dropped connection", async () => {
    const asked: RequestInit[] = [];
    const reachable = async (_url: string | URL | Request, init?: RequestInit) => {
      asked.push(init ?? {});
      return new Response(null, { status: 405 });
    };
    assert.equal(await originRefused(ask, reachable as typeof fetch), true);
    assert.equal(asked[0]?.mode, "no-cors", "an opaque request, which no domain lock stops");
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    assert.equal(await originRefused(ask, offline as typeof fetch), false);
  });
});

describe("sources", () => {
  it("only lets http(s) links through", () => {
    assert.equal(safeHref("https://www.acme.com/hours"), "https://www.acme.com/hours");
    assert.equal(safeHref("javascript:alert(document.cookie)"), undefined);
    assert.equal(safeHref("data:text/html,<script>alert(1)</script>"), undefined);
    assert.equal(safeHref(" "), undefined);
    assert.equal(safeHref(undefined), undefined);
  });

  const resources = {
    r1: { id: "r1", title: "Opening hours", origin: { url: "https://acme.com/hours" } },
    r2: { id: "r2", title: "Insurance", origin: { url: "https://acme.com/insurance" } },
    r3: { id: "r3", title: "Evil", origin: { url: "javascript:alert(1)" } },
    r4: { id: "r4", title: "", origin: { url: "https://acme.com/hours" } },
  };

  // Every page relates to this question equally, so only the order and the links are tested here
  // (test/sources.test.ts has which pages fit).
  const ctx = { question: "Hours, insurance, evil, weak, good, best?", answer: "" };

  it("lists cited resources in citation order, once per URL", () => {
    const citations = { "r2/t/body/0-50": [[0, 10]], "r1/t/body/0-80": [[11, 20]], "r2/t/body/51-90": [[21, 30]] };
    assert.deepEqual(sourcesFor(resources, citations, ctx), [
      { title: "Insurance", href: "https://acme.com/insurance" },
      { title: "Opening hours", href: "https://acme.com/hours" },
    ]);
  });

  it("falls back to the best relevant retrieved resources when nothing was cited", () => {
    const para = (score: number) => ({ "/t/text": { paragraphs: { p: { score, score_type: "RERANKER" } } } });
    const ranked = {
      weak: { id: "weak", title: "Weak", origin: { url: "https://acme.com/weak" }, fields: para(0.001) },
      good: { id: "good", title: "Good", origin: { url: "https://acme.com/good" }, fields: para(0.3) },
      best: { id: "best", title: "Best", origin: { url: "https://acme.com/best" }, fields: para(0.5) },
    };
    assert.deepEqual(
      sourcesFor(ranked, {}, ctx).map((s) => s.title),
      ["Best", "Good"],
    );
  });

  it("falls back to retrieved resources, skipping unsafe and duplicate links", () => {
    assert.deepEqual(
      sourcesFor(resources, {}, ctx).map((s) => s.href),
      ["https://acme.com/hours", "https://acme.com/insurance"],
    );
  });
});
