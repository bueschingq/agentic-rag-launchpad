// The question event (round 4: test questions counted as the client's when a scripted tab closed
// a second after the answer and its batch was lost).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BatchTransport, consoleEvent, EventBatch } from "../src/analytics.ts";

function transport() {
  const posted: string[] = [];
  const beaconed: string[] = [];
  const pending: (() => void)[] = [];
  const t: BatchTransport = {
    beacon: (_url, body) => {
      beaconed.push(body);
      return true;
    },
    post: (_url, body) => {
      posted.push(body);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
  };
  const settle = () => {
    for (const resolve of pending.splice(0)) resolve();
  };
  return { t, posted, beaconed, settle };
}

describe("the question event", () => {
  it("goes at once, on its own, with the conversation and the question's hash only", () => {
    const { t, posted } = transport();
    const batch = new EventBatch("https://console/api/public/deployments/d/events", t, 60_000);
    batch.question("c1", "0123456789abcdef");
    assert.deepEqual(
      posted.map((b) => JSON.parse(b)),
      [{ type: "question", conversationId: "c1", questionHash: "0123456789abcdef" }],
    );
  });

  it("goes again with the beacon if the page hides before the post has gone through, and not once it has", async () => {
    const { t, beaconed, settle } = transport();
    const batch = new EventBatch("u", t, 60_000);
    batch.question("c1", "0123456789abcdef");
    batch.flush(true);
    assert.equal(beaconed.length, 1, "the tab closed with the post in flight");
    batch.question("c1", "fedcba9876543210");
    settle();
    await new Promise((r) => setTimeout(r, 0));
    batch.flush(true);
    assert.equal(beaconed.length, 1, "already delivered");
  });

  it("leaves the batch as it was: answers still wait for the timer or the beacon", () => {
    const { t, posted, beaconed } = transport();
    const batch = new EventBatch("u", t, 60_000);
    batch.add(consoleEvent("arag_chat_answer", { conversation_id: "c1", answered: false, question_hash: "0123456789abcdef" })!);
    assert.equal(posted.length, 0);
    batch.flush(true);
    assert.deepEqual(JSON.parse(beaconed[0]!).events[0].answered, false);
  });
});
