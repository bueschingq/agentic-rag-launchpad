import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAsk, readAskStream, readNdjson } from "../src/ask-stream.ts";
import { chunkedStream } from "./helpers.ts";

// Shaped like the M0 capture: answer chunks, then retrieval, citations, metadata, status.
const STREAM = [
  { item: { type: "answer", text: "Yes, we accept " } },
  { item: { type: "answer", text: "Aetna PPO plans." } },
  {
    item: {
      type: "retrieval",
      results: { resources: { r1: { id: "r1", title: "Insurance and payment", origin: { url: "https://example.com/insurance" } } } },
    },
  },
  { item: { type: "citations", citations: { "r1/t/body/0-120": [[0, 31]] } } },
  { item: { type: "metadata", tokens: { input: 812, output: 9 }, timings: { generative_first_chunk: 0.9 } } },
  { item: { type: "consumption", normalized_tokens: { input: 0.18 } } },
  { item: { type: "augmented_context", paragraphs: {} } },
  { item: { type: "status", status: "success", code: "0", details: null } },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

describe("ask stream", () => {
  it("parses lines split across arbitrary chunk boundaries", async () => {
    const lines: unknown[] = [];
    for await (const line of readNdjson(chunkedStream(STREAM, [5, 17, 3, 64, 1, 200]))) lines.push(line);
    assert.equal(lines.length, 8);
  });

  it("handles a final line with no trailing newline", async () => {
    const lines: unknown[] = [];
    for await (const line of readNdjson(chunkedStream('{"a":1}\n{"b":2}', [4]))) lines.push(line);
    assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
  });

  it("collects the answer, sources, citations and status", async () => {
    const summary = await collectAsk(readAskStream(chunkedStream(STREAM, [9])));
    assert.equal(summary.answer, "Yes, we accept Aetna PPO plans.");
    assert.equal(summary.resources.r1?.origin?.url, "https://example.com/insurance");
    assert.deepEqual(Object.keys(summary.citations), ["r1/t/body/0-120"]);
    assert.equal(summary.status, "success");
  });

  it("keeps unknown item types instead of dropping them", async () => {
    const items = [];
    for await (const item of readAskStream(chunkedStream('{"item":{"type":"reasoning","text":"…"}}\n', [100]))) items.push(item);
    assert.deepEqual(items, [{ type: "other", itemType: "reasoning", raw: { type: "reasoning", text: "…" } }]);
  });

  it("reports malformed lines clearly", async () => {
    await assert.rejects(async () => {
      for await (const _ of readNdjson(chunkedStream('{"ok":1}\nnot json\n', [100]))) {
      }
    }, /Malformed NDJSON line from \/ask: not json/);
  });

  it("cancels the download when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"item":{"type":"answer","text":"x"}}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const item of readAskStream(body)) {
      assert.equal(item.type, "answer");
      break;
    }
    assert.equal(cancelled, true);
  });
});
