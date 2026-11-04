import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliver, postWebhook, webhookUrlProblem } from "../src/index.ts";

describe("webhookUrlProblem", () => {
  it("takes https anywhere and http only on this machine", () => {
    assert.equal(webhookUrlProblem("https://hooks.slack.com/services/T/B/x"), undefined);
    assert.equal(webhookUrlProblem("http://localhost:4300/hook"), undefined);
    assert.ok(webhookUrlProblem("http://hooks.example.com/x"));
    assert.ok(webhookUrlProblem("not a url"));
  });
});

describe("deliver", () => {
  it("posts Slack-compatible text plus structured fields", async () => {
    let body: Record<string, unknown> = {};
    await postWebhook(
      "https://hooks.example.com/x",
      {
        subject: "Budget at 80%",
        text: "Harbor View Dental has used 80% of its budget.",
        fields: { Spent: "$80" },
        link: "https://console/x",
      },
      { kind: "alert" },
      async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      },
    );
    assert.match(String(body.text), /^\*Budget at 80%\*\nHarbor View Dental/);
    assert.deepEqual(body.fields, { Spent: "$80" });
    assert.equal(body.kind, "alert");
  });

  it("reports each channel's outcome, and skips email without SMTP", async () => {
    const failing = async () => new Response(null, { status: 500 });
    const result = await deliver(
      { webhookUrl: "https://hooks.example.com/x", emails: ["ops@example.com"] },
      { subject: "s", text: "t" },
      { fetch: failing, env: {} },
    );
    assert.deepEqual(result, { delivered: [], errors: ["webhook: The webhook answered 500."] });
  });
});
