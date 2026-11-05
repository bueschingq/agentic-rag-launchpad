import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lockCheck, settled } from "../src/jobs/domain-lock.ts";

const preflight = (allowed: (origin: string) => string | null, status = 200): typeof fetch =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const origin = new Headers(init?.headers).get("Origin")!;
    const value = allowed(origin);
    return new Response(null, { status, headers: value ? { "access-control-allow-origin": value } : {} });
  }) as typeof fetch;

describe("domain lock recheck", () => {
  const origins = ["https://www.example.com", "http://localhost:4181"];

  it("passes an origin only when the KB echoes it back", async () => {
    const result = await lockCheck(
      "aws-us-east-2-1",
      "kb1",
      origins,
      preflight((o) => (o.includes("localhost") ? null : o)),
    );
    assert.deepEqual(
      result.origins.map((o) => o.ok),
      [true, false],
    );
  });

  it("records once every domain passes, or after 10 minutes whatever it says", () => {
    const changed = new Date("2026-10-30T12:00:00Z");
    const pass = { at: "", origins: [{ origin: origins[0]!, ok: true, status: 200 }] };
    const fail = { at: "", origins: [{ origin: origins[0]!, ok: false, status: 403 }] };
    assert.ok(settled(pass, changed, new Date("2026-10-30T12:01:00Z")));
    assert.ok(!settled(fail, changed, new Date("2026-10-30T12:05:00Z")));
    assert.ok(settled(fail, changed, new Date("2026-10-30T12:10:00Z")));
  });
});
