import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cspSnippet, imageSource } from "../src/lib/csp.ts";
import { type InstallFacts, judgeInstall, missingCsp } from "../src/lib/install-check.ts";

const CONSOLE = "https://launchpad.agency.example";
// The scan's inline SVG logo, as the avatar.
const SVG_LOGO = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E";

describe("the CSP entries for the avatar", () => {
  it("advise img-src data: for an inline logo, never null", () => {
    const snippet = cspSnippet({ consoleOrigin: CONSOLE, zone: "aws-us-east-2-1", avatarUrl: SVG_LOGO });
    assert.equal(snippet, `script-src ${CONSOLE};\nconnect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud;\nimg-src data:`);
    assert.doesNotMatch(snippet, /null/);
    assert.equal(imageSource("data:image/png;base64,iVBORw0KGgo="), "data:");
    assert.equal(imageSource("https://cdn.client.com/logo.svg?v=2"), "https://cdn.client.com");
    assert.equal(imageSource("not a url"), undefined);
  });

  it("need nothing for images without an avatar, or with one on the console", () => {
    assert.doesNotMatch(cspSnippet({ consoleOrigin: CONSOLE, zone: "aws-us-east-2-1" }), /img-src/);
    assert.doesNotMatch(cspSnippet({ consoleOrigin: CONSOLE, zone: "aws-us-east-2-1", avatarUrl: `${CONSOLE}/logo.png` }), /img-src/);
  });
});

describe("Check installation and images", () => {
  const deployment = {
    id: "dep-1",
    domains: ["https://www.client.com"],
    consoleOrigin: CONSOLE,
    zone: "aws-us-east-2-1",
    avatar: SVG_LOGO,
  };
  const allowed = `script-src 'self' ${CONSOLE}; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud`;
  const facts = (csp: string[], rendered = true): InstallFacts => ({
    url: "https://www.client.com/",
    finalUrl: "https://www.client.com/",
    status: 200,
    origin: "https://www.client.com",
    csp,
    scripts: [{ src: `${CONSOLE}/arag-chat.js`, deployment: "dep-1" }],
    elements: [{ deployment: "dep-1", rendered }],
    messages: [],
  });
  const line = (checks: ReturnType<typeof judgeInstall>, label: string) => checks.find((c) => c.label === label)!;

  it("finds an img-src, or a default-src it falls back to, that blocks the inline logo", () => {
    const needs = { script: [], connect: [], image: [SVG_LOGO] };
    assert.deepEqual(missingCsp(["default-src 'self'"], needs, "https://www.client.com"), ["img-src data:"]);
    assert.deepEqual(missingCsp(["img-src 'self' https:"], needs, "https://www.client.com"), ["img-src data:"]);
    assert.deepEqual(missingCsp(["img-src 'self' data:"], needs, "https://www.client.com"), []);
    assert.deepEqual(
      missingCsp(["script-src 'self'"], needs, "https://www.client.com"),
      [],
      "no img-src or default-src: images are allowed",
    );
    const https = { script: [], connect: [], image: ["https://cdn.client.com/logo.png"] };
    assert.deepEqual(missingCsp(["img-src 'self'"], https, "https://www.client.com"), ["img-src https://cdn.client.com"]);
  });

  it("says the chat works but its logo is blocked, as one thing to fix", () => {
    const checks = judgeInstall(facts([`${allowed}; img-src 'self'`]), deployment);
    const csp = line(checks, "Content Security Policy");
    assert.equal(csp.result, "fail");
    assert.match(
      csp.detail,
      /The chat works, but the site's CSP blocks its logo\. Add this source to the existing directives: img-src data:\./,
    );
    assert.equal(line(checks, "Widget shows").result, "pass");
    assert.equal(checks.filter((c) => c.result === "fail").length, 1);
  });

  it("puts the logo's source on the same advice line as the rest, and counts one fix (/csp-blocked)", () => {
    const checks = judgeInstall(facts(["default-src 'self'"], false), deployment);
    const csp = line(checks, "Content Security Policy");
    assert.equal(
      csp.detail,
      `The site's CSP blocks the widget. Add these sources to the existing directives: script-src ${CONSOLE}; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud; img-src data:.`,
    );
    assert.equal(line(checks, "Widget shows").result, "warn");
    assert.deepEqual(
      checks.filter((c) => c.result === "fail").map((c) => c.label),
      ["Content Security Policy"],
    );
  });

  it("passes a policy that allows the logo, and a deployment without one", () => {
    assert.equal(line(judgeInstall(facts([`${allowed}; img-src 'self' data:`]), deployment), "Content Security Policy").result, "pass");
    assert.equal(
      line(judgeInstall(facts([`${allowed}; img-src 'self'`]), { ...deployment, avatar: undefined }), "Content Security Policy").result,
      "pass",
    );
  });
});
