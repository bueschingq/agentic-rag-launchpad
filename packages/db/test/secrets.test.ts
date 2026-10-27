import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { credentialContext, openSecret, parseMasterKey, sealSecret } from "../src/secrets.ts";

const key = randomBytes(32);
const ctx = credentialContext("dep-1", "reader");

describe("sealed secrets", () => {
  it("round-trips and never repeats a ciphertext", () => {
    const a = sealSecret("eyJhbGciOi.reader.key", key, ctx);
    const b = sealSecret("eyJhbGciOi.reader.key", key, ctx);
    assert.notEqual(a, b);
    assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(openSecret(a, key, ctx), "eyJhbGciOi.reader.key");
  });

  it("refuses a ciphertext moved to another deployment or role", () => {
    const sealed = sealSecret("k", key, ctx);
    assert.throws(() => openSecret(sealed, key, credentialContext("dep-2", "reader")), /could not be opened/);
    assert.throws(() => openSecret(sealed, key, credentialContext("dep-1", "manager")), /could not be opened/);
  });

  it("detects tampering and a wrong master key", () => {
    const sealed = sealSecret("k", key, ctx);
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    parts[3] = flipped.toString("base64url");
    assert.throws(() => openSecret(parts.join("."), key, ctx), /could not be opened/);
    assert.throws(() => openSecret(sealed, randomBytes(32), ctx), /could not be opened/);
    assert.throws(() => openSecret("v0.a.b.c", key, ctx), /Unrecognised/);
  });

  it("insists on a 32-byte master key", () => {
    assert.equal(parseMasterKey(randomBytes(32).toString("base64")).length, 32);
    assert.throws(() => parseMasterKey(undefined), /32 random bytes/);
    assert.throws(() => parseMasterKey(randomBytes(16).toString("base64")), /32 random bytes/);
  });
});
