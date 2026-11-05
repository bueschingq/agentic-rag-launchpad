import assert from "node:assert/strict";
import { test } from "node:test";
import { historyActor } from "../src/lib/history.ts";
import { cleanSetupName, decodeSetupName, setupNameDetail } from "../src/lib/setup-name.ts";

test("a setup-mode entry with no name of its own records the session's typed name", () => {
  const add = setupNameDetail({ actorUserId: null, action: "content.sync", detail: {} }, "Dana");
  assert.deepEqual(add, { name: "Dana", verified: false });
  // History then names Dana, marked once, instead of "Someone in setup mode" (7d).
  assert.equal(historyActor("content.sync", { ...add }, null), "Dana (not verified)");
});

test("entries that already say who it was, or aren't a person's, are left alone", () => {
  assert.equal(setupNameDetail({ actorUserId: "u1", action: "content.sync", detail: {} }, "Dana"), undefined);
  assert.equal(setupNameDetail({ actorUserId: null, action: "deployment.signoff", detail: { name: "Sam" } }, "Dana"), undefined);
  assert.equal(setupNameDetail({ actorUserId: null, action: "deployment.validate", detail: { auto: true } }, "Dana"), undefined);
  assert.equal(setupNameDetail({ actorUserId: null, action: "deployment.install-check", detail: { via: "share" } }, "Dana"), undefined);
  assert.equal(setupNameDetail({ actorUserId: null, action: "content.sync", detail: {} }, undefined), undefined);
});

test("setup mode's placeholder is replaced, and a create entry keeps the deployment's name", () => {
  assert.deepEqual(setupNameDetail({ actorUserId: null, action: "deployment.skip", detail: { name: "Setup admin" } }, "Dana"), {
    name: "Dana",
    verified: false,
  });
  const add = setupNameDetail({ actorUserId: null, action: "deployment.create", detail: { name: "Main site" } }, "Dana");
  assert.deepEqual(add, { typedBy: "Dana" });
  assert.equal(historyActor("deployment.create", { name: "Main site", ...add }, null), "Dana (not verified)");
});

test("a typed name is stored without its marker", () => {
  assert.equal(cleanSetupName("Sam (setup mode, not verified)"), "Sam");
  assert.equal(cleanSetupName("  "), undefined);
  assert.equal(cleanSetupName("Setup admin"), undefined);
});

test("a name with spaces round-trips unchanged through several saves (round 6: H2%20Verifier → H2%25252520Verifier)", () => {
  // Next's cookies() encodes a value when it sets the cookie and decodes it when it reads one;
  // the browser reads document.cookie raw and decodes once (components/typed-name.ts).
  const header = (value: string) => encodeURIComponent(value);
  let typed = "H2 Verifier";
  for (let save = 0; save < 5; save++) {
    // The server keeps the confirmed name in the session cookie, as it is (withSetupName).
    const stored = cleanSetupName(typed)!;
    const cookie = header(stored);
    // Server side, the next entry with no name reads it back through cookies().
    assert.deepEqual(setupNameDetail({ actorUserId: null, action: "content.sync", detail: {} }, decodeURIComponent(cookie)), {
      name: "H2 Verifier",
      verified: false,
    });
    // The browser prefills the next name field from it, and the partner saves it as it is.
    typed = decodeSetupName(cookie);
    assert.equal(typed, "H2 Verifier", `save ${save + 1}`);
  }
});

test("names already stored encoded, once or more, heal", () => {
  assert.equal(decodeSetupName("H2%25252520Verifier"), "H2 Verifier");
  assert.equal(decodeSetupName("H3%20verifier"), "H3 verifier");
  assert.equal(cleanSetupName("H2%252520Verifier (setup mode, not verified)"), "H2 Verifier");
  assert.equal(decodeSetupName("100% sure"), "100% sure");
  assert.equal(decodeSetupName("Zoë"), "Zoë");
});
