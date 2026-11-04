// Round 6's re-check: the Agentic RAG account blocked for budget (402), every chat down, nobody told.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ParError } from "@launchpad/par-client";
import { accountAlert, accountBlockState, BLOCKED, blockedMessage, UNBLOCKED } from "../src/lib/account-block.ts";
import { accountSignalFromBody } from "../src/lib/widget-events.ts";

describe("the Agentic RAG account blocked", () => {
  it("knows the block from Agentic RAG's 402, by status or by its words", () => {
    const seen = new ParError("POST", "https://aws-us-east-2-1.dp.progress.cloud/api/v1/kb/69bf282a/ask?eph-token=x", 402, {
      detail:
        "Access denied, as account c906143b has an active 'AccountBlockingState.BUDGET' blockage on this features: upload,processing,search,generative,training",
    });
    assert.equal(accountBlockState(seen), "BUDGET");
    assert.equal(accountBlockState({ status: 402 }), "BUDGET");
    assert.equal(accountBlockState(new Error("/ask returned 402")), "BUDGET");
    assert.equal(accountBlockState(new Error("blocked: AccountBlockingState.SUSPENDED")), "SUSPENDED");
    for (const other of [
      new ParError("GET", "https://x/kb/1", 403, {}),
      new Error("/ask returned 500"),
      new Error("4020 pages"),
      undefined,
    ])
      assert.equal(accountBlockState(other), undefined);
  });

  it("posts the block once to the partner's channel, and the all-clear within a day", () => {
    const at = new Date("2026-10-31T15:13:00Z");
    const blocked = accountAlert({ id: 7, action: BLOCKED, at, state: "BUDGET" }, at, "https://console/");
    assert.equal(blocked?.key, "account-blocked:7");
    assert.equal(blocked?.message.subject, "Agentic RAG account blocked for budget: every chat is down until it's cleared");
    assert.equal(blockedMessage("BUDGET"), blocked?.message.subject);
    assert.match(blocked?.message.text ?? "", /Since 2026-10-31 15:13 UTC.*offline message/);
    const clear = accountAlert({ id: 9, action: UNBLOCKED, at, state: "BUDGET" }, new Date("2026-10-31T16:00:00Z"));
    assert.equal(clear?.key, "account-unblocked:9");
    assert.equal(accountAlert({ id: 9, action: UNBLOCKED, at, state: "BUDGET" }, new Date("2026-11-02T16:00:00Z")), undefined);
    assert.equal(accountAlert(undefined, at), undefined);
  });

  it("hears the block from the widget, and answers working again", () => {
    const batch = (events: object[]) => JSON.stringify({ events });
    assert.equal(
      accountSignalFromBody(batch([{ name: "arag_chat_answer", conversation_id: "c-1", answered: false, blocked: true }])),
      "blocked",
    );
    assert.equal(
      accountSignalFromBody(
        batch([
          { name: "arag_chat_answer", conversation_id: "c-12345678", question_hash: "0123456789abcdef", answered: true, attempts: 1 },
        ]),
      ),
      "answering",
    );
    assert.equal(accountSignalFromBody(batch([{ name: "arag_chat_open", conversation_id: "c-1" }])), undefined);
  });
});
