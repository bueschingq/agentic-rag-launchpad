import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ParError } from "../src/errors.ts";
import { buildUrl, requestJson, zoneApi } from "../src/http.ts";
import { json, mockFetch } from "./helpers.ts";

describe("http", () => {
  it("puts ephemeral tokens in the query string, not a header", async () => {
    const { fetch, calls } = mockFetch(() => json({ ok: true }));
    await requestJson("https://z.dp.progress.cloud/api/v1/kb/k/ask", {
      credential: { kind: "ephemeral", token: "tok/+=" },
      body: { query: "hi" },
      fetch,
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("eph-token"), "tok/+=");
    assert.equal(calls[0]!.headers["X-NUCLIA-SERVICEACCOUNT"], undefined);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["Content-Type"], "application/json");
  });

  it("repeats array query parameters", () => {
    const url = new URL(buildUrl("https://x.test/r", { show: ["basic", "origin"], skip: undefined, n: 3 }));
    assert.deepEqual(url.searchParams.getAll("show"), ["basic", "origin"]);
    assert.equal(url.searchParams.has("skip"), false);
    assert.equal(url.searchParams.get("n"), "3");
  });

  it("raises ParError with the API detail and without the query string", async () => {
    const { fetch } = mockFetch(() => json({ detail: "Nuakeys are not valid in the global API" }, 403));
    await assert.rejects(
      requestJson("https://accounts.progress.cloud/api/v1/accounts", { credential: { kind: "ephemeral", token: "secret" }, fetch }),
      (err: unknown) => {
        assert.ok(err instanceof ParError);
        assert.equal(err.status, 403);
        assert.match(err.message, /Nuakeys are not valid/);
        assert.doesNotMatch(err.message, /secret/);
        return true;
      },
    );
  });

  it("summarises validation errors", async () => {
    const detail = [{ loc: ["body", "allowed_origins"], msg: "List should have at least 1 item after validation, not 0" }];
    const { fetch } = mockFetch(() => json({ detail }, 422));
    await assert.rejects(requestJson("https://x.test/kb", { method: "PATCH", body: {}, fetch }), /body\.allowed_origins List should have/);
  });

  it("rejects zone slugs that could change the host", () => {
    assert.equal(zoneApi("aws-us-east-2-1"), "https://aws-us-east-2-1.dp.progress.cloud/api/v1");
    assert.throws(() => zoneApi("evil.example/x"), /Invalid zone/);
  });
});
