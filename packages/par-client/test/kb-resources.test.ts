// putTextResource: a synced page with its page-type labels and metadata (round 5, Track A).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KbClient } from "../src/kb.ts";
import { json, mockFetch } from "./helpers.ts";

const ZONE = "aws-us-east-2-1";
const KB = "00000000-0000-4000-8000-0000000000b1";
const page = {
  slug: "page-abc",
  title: "How to buy",
  originUrl: "https://www.chef.io/how-to-buy",
  body: "# How to buy\n\n$ 59 per node, per year",
  labels: [{ labelset: "launchpad_page", label: "price" }],
  metadata: { launchpad: { intent: "price", about: "About this page: prices, plans, quotes and what it costs." } },
};

describe("KbClient.putTextResource", () => {
  it("sends the labels as usermetadata.classifications and the metadata as extra.metadata", async () => {
    const { fetch, calls } = mockFetch(() => json({ uuid: "r1" }, 201));
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "writer" }, fetch });
    assert.deepEqual(await kb.putTextResource(page), { uuid: "r1", created: true, labelled: true });
    assert.equal(calls[0]!.url, `https://${ZONE}.dp.progress.cloud/api/v1/kb/${KB}/resources`);
    assert.deepEqual(calls[0]!.body, {
      slug: "page-abc",
      title: "How to buy",
      origin: { url: "https://www.chef.io/how-to-buy" },
      texts: { body: { body: page.body, format: "MARKDOWN" } },
      usermetadata: { classifications: [{ labelset: "launchpad_page", label: "price" }] },
      extra: { metadata: page.metadata },
    });
  });

  it("replaces the labels too when the slug exists, so a page that loses one loses it in the KB", async () => {
    const { fetch, calls } = mockFetch((call) =>
      call.method === "POST" ? json({ detail: "exists" }, 409) : new Response(null, { status: 200 }),
    );
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "writer" }, fetch });
    const res = await kb.putTextResource({ ...page, labels: [], metadata: undefined });
    assert.deepEqual(res, { created: false, labelled: true });
    assert.equal(calls[1]!.method, "PATCH");
    assert.equal(calls[1]!.url, `https://${ZONE}.dp.progress.cloud/api/v1/kb/${KB}/slug/page-abc`);
    assert.deepEqual((calls[1]!.body as { usermetadata: unknown }).usermetadata, { classifications: [] });
    assert.equal((calls[1]!.body as { extra?: unknown }).extra, undefined);
  });

  it("sends the page once more without labels if Agentic RAG refuses them", async () => {
    const { fetch, calls } = mockFetch((call) =>
      (call.body as { usermetadata?: unknown }).usermetadata ? json({ detail: "bad labels" }, 422) : json({ uuid: "r2" }, 201),
    );
    const kb = new KbClient({ zone: ZONE, kbId: KB, credential: { kind: "key", token: "writer" }, fetch });
    assert.deepEqual(await kb.putTextResource(page), { uuid: "r2", created: true, labelled: false });
    assert.equal(calls.length, 2);
    assert.equal((calls[1]!.body as { usermetadata?: unknown }).usermetadata, undefined);
  });
});
