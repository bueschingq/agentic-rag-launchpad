import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicTokenResponse } from "@launchpad/theme";
import { TokenSession } from "../src/session.ts";
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
    const session = new TokenSession(async () => token(++fetched), () => now);
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

  it("lists cited resources in citation order, once per URL", () => {
    const citations = { "r2/t/body/0-50": [[0, 10]], "r1/t/body/0-80": [[11, 20]], "r2/t/body/51-90": [[21, 30]] };
    assert.deepEqual(sourcesFor(resources, citations), [
      { title: "Insurance", href: "https://acme.com/insurance" },
      { title: "Opening hours", href: "https://acme.com/hours" },
    ]);
  });

  it("falls back to retrieved resources, skipping unsafe and duplicate links", () => {
    assert.deepEqual(
      sourcesFor(resources, {}).map((s) => s.href),
      ["https://acme.com/hours", "https://acme.com/insurance"],
    );
  });
});
