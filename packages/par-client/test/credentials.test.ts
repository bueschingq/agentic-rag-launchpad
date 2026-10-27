import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authHeaders, classifyToken, nuaAllowsKbManagement, nuaZone } from "../src/credentials.ts";
import { fakeJwt, NUA_KEY } from "./helpers.ts";

describe("credentials", () => {
  it("recognises a NUA key from its zone issuer and KB-management claim", () => {
    assert.equal(classifyToken(NUA_KEY), "nua");
    assert.equal(nuaZone(NUA_KEY), "aws-us-east-2-1");
    assert.equal(nuaAllowsKbManagement(NUA_KEY), true);
  });

  it("treats other tokens as user-level (PAT) tokens", () => {
    assert.equal(classifyToken(fakeJwt({ iss: "https://accounts.progress.cloud/", sub: "u" })), "user");
    assert.equal(classifyToken("opaque-personal-access-token"), "user");
    assert.equal(classifyToken("  "), "empty");
  });

  it("does not accept look-alike issuers as zones", () => {
    const spoof = fakeJwt({ iss: "https://evil.example/aws-us-east-2-1.dp.progress.cloud/", allow_kb_management: true });
    assert.equal(nuaZone(spoof), undefined);
    assert.equal(classifyToken(spoof), "user");
  });

  it("sends each credential in its own header, and ephemeral tokens in none", () => {
    assert.deepEqual(authHeaders({ kind: "nua", token: "n" }), { "X-NUCLIA-NUAKEY": "Bearer n" });
    assert.deepEqual(authHeaders({ kind: "user", token: "u" }), { Authorization: "Bearer u" });
    assert.deepEqual(authHeaders({ kind: "key", token: "k" }), { "X-NUCLIA-SERVICEACCOUNT": "Bearer k" });
    assert.deepEqual(authHeaders({ kind: "ephemeral", token: "e" }), {});
    assert.deepEqual(authHeaders(undefined), {});
  });
});
