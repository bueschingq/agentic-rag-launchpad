import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { cspAdvice, cspAllows, type InstallFacts, inlineScriptsAllowed, judgeInstall, missingCsp } from "../src/lib/install-check.ts";
import { parseLead } from "../src/lib/leads.ts";
import { completeSignIn, OidcError, pkceChallenge, verifyIdToken } from "../src/lib/oidc.ts";
import { groupQuestions, qualityWords } from "../src/lib/report.ts";
import { countsFromBody } from "../src/lib/widget-events.ts";

const CONSOLE = "https://launchpad.agency.example";
const deployment = { id: "dep-1", domains: ["https://www.client.com"], consoleOrigin: CONSOLE, zone: "aws-us-east-2-1" };
const facts = (over: Partial<InstallFacts> = {}): InstallFacts => ({
  url: "https://www.client.com/",
  finalUrl: "https://www.client.com/",
  status: 200,
  origin: "https://www.client.com",
  csp: [],
  scripts: [{ src: `${CONSOLE}/arag-chat.js`, deployment: "dep-1" }],
  elements: [{ deployment: "dep-1", rendered: true }],
  messages: [],
  ...over,
});
const failing = (checks: ReturnType<typeof judgeInstall>) => checks.filter((c) => c.result === "fail").map((c) => c.label);

describe("cspAllows", () => {
  it("understands hosts, wildcards, schemes and 'self'", () => {
    assert.ok(cspAllows(["https://launchpad.agency.example"], `${CONSOLE}/arag-chat.js`, "https://www.client.com"));
    assert.ok(cspAllows(["*.agency.example"], `${CONSOLE}/x`, "https://www.client.com"));
    assert.ok(cspAllows(["https:"], `${CONSOLE}/x`, "https://www.client.com"));
    assert.ok(!cspAllows(["'self'"], `${CONSOLE}/x`, "https://www.client.com"));
    assert.ok(!cspAllows(["'none'"], `${CONSOLE}/x`, "https://www.client.com"));
  });

  it("names the missing directives, falling back to default-src", () => {
    const policy = "default-src 'self'; script-src 'self' https://launchpad.agency.example";
    const missing = missingCsp(
      [policy],
      { script: [`${CONSOLE}/arag-chat.js`], connect: [`${CONSOLE}/api/`, "https://aws-us-east-2-1.dp.progress.cloud/api/"] },
      "https://www.client.com",
    );
    assert.deepEqual(missing, ["connect-src https://launchpad.agency.example", "connect-src https://aws-us-east-2-1.dp.progress.cloud"]);
  });
});

describe("judgeInstall", () => {
  it("passes a correct installation", () => {
    assert.deepEqual(failing(judgeInstall(facts(), deployment)), []);
  });

  it("names the snippet for another deployment", () => {
    const checks = judgeInstall(facts({ scripts: [{ src: `${CONSOLE}/arag-chat.js`, deployment: "other" }], elements: [] }), deployment);
    assert.match(checks.find((c) => c.label === "Snippet")!.detail, /another deployment/);
  });

  it("names a www/apex mismatch", () => {
    const checks = judgeInstall(facts({ origin: "https://client.com", finalUrl: "https://client.com/" }), deployment);
    assert.match(checks.find((c) => c.label === "Domain allowed")!.detail, /Only https:\/\/www\.client\.com is allowed/);
  });

  it("names the CSP directive that blocks the widget", () => {
    const checks = judgeInstall(
      facts({ csp: [`script-src 'self' ${CONSOLE}; connect-src 'self'`], elements: [{ deployment: "dep-1", rendered: false }] }),
      deployment,
    );
    // One directive to fix: the chat not showing is its consequence, not a second fix.
    assert.deepEqual(failing(checks), ["Content Security Policy"]);
    assert.equal(checks.find((c) => c.label === "Widget shows")!.result, "warn");
    assert.match(checks.find((c) => c.label === "Content Security Policy")!.detail, /connect-src https:\/\/launchpad\.agency\.example/);
  });

  it("advises one merged directive each, never the same directive twice", () => {
    const checks = judgeInstall(facts({ csp: ["default-src 'self'"], elements: [{ deployment: "dep-1", rendered: false }] }), deployment);
    const detail = checks.find((c) => c.label === "Content Security Policy")!.detail;
    assert.ok(detail.includes(`script-src ${CONSOLE}; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud.`), detail);
    assert.equal(detail.match(/connect-src/g)?.length, 1);
    assert.equal(cspAdvice(["connect-src a", "script-src b", "connect-src c"]), "connect-src a c; script-src b");
  });

  it("follows script-src-elem ahead of script-src", () => {
    const missing = missingCsp(
      [`script-src 'self' ${CONSOLE}; script-src-elem 'self'`],
      { script: [`${CONSOLE}/arag-chat.js`], connect: [] },
      "https://www.client.com",
    );
    assert.deepEqual(missing, [`script-src-elem ${CONSOLE}`]);
  });

  it("finds the deployment in the script's address", () => {
    const checks = judgeInstall(facts({ scripts: [{ src: `${CONSOLE}/arag-chat.js?deployment=dep-1`, deployment: "dep-1" }] }), deployment);
    assert.deepEqual(failing(checks), []);
  });

  it("explains JavaScript code that a CSP without inline scripts never ran", () => {
    const blocked = facts({
      csp: [`script-src 'self' ${CONSOLE}; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud`],
      scripts: [],
      loaders: [{ deployment: "dep-1" }],
      elements: [],
    });
    const checks = judgeInstall(blocked, deployment);
    // One thing to do (Link to a file), so one line to fix.
    assert.deepEqual(failing(checks), ["Snippet"]);
    assert.match(
      checks.find((c) => c.label === "Snippet")!.detail,
      /blocks inline scripts.*Link to a file.*arag-chat\.js\?deployment=dep-1/,
    );
    assert.ok(inlineScriptsAllowed(["script-src 'self' 'unsafe-inline'"]));
    assert.ok(!inlineScriptsAllowed(["script-src 'self' 'unsafe-inline' 'nonce-abc'"]));
    assert.ok(inlineScriptsAllowed([]));
  });

  it("says the chat waits for sign-off when the snippet is in place early", () => {
    const checks = judgeInstall(facts({ elements: [{ deployment: "dep-1", rendered: false }] }), {
      ...deployment,
      provisioned: true,
      published: false,
      partner: "Northwind Digital",
    });
    assert.deepEqual(failing(checks), []);
    const shows = checks.find((c) => c.label === "Widget shows")!;
    assert.equal(shows.result, "warn");
    assert.match(shows.detail, /appears once Northwind Digital signs it off/);
  });

  it("reads 'strict-dynamic': listed hosts don't count, the page's nonce does", () => {
    const policy = `script-src 'nonce-r4nd0m' 'strict-dynamic' ${CONSOLE}; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud`;
    // A plain <script src>: blocked, though its host is listed, and the browser didn't render it.
    const plain = judgeInstall(facts({ csp: [policy], elements: [{ deployment: "dep-1", rendered: false }] }), deployment);
    assert.deepEqual(failing(plain), ["Content Security Policy"]);
    assert.match(plain.find((c) => c.label === "Content Security Policy")!.detail, /'strict-dynamic'.*nonce/);
    // The JavaScript code in a script that carries the nonce: it runs, and so does what it adds.
    const nonced = judgeInstall(
      facts({
        csp: [policy],
        scripts: [],
        loaders: [{ deployment: "dep-1", nonce: true }],
        elements: [{ deployment: "dep-1", rendered: true }],
      }),
      deployment,
    );
    assert.deepEqual(failing(nonced), []);
    assert.ok(inlineScriptsAllowed(["script-src 'nonce-r4nd0m' 'strict-dynamic'"], true));
  });

  it("believes the page's render over its reading of the policy, both ways", () => {
    // Our reading says blocked, but the chat drew itself: the script and config loaded.
    const rendered = judgeInstall(
      facts({ csp: [`script-src 'self' 'nonce-x'; connect-src ${CONSOLE} https://aws-us-east-2-1.dp.progress.cloud`] }),
      deployment,
    );
    assert.deepEqual(failing(rendered), []);
    // Our reading says fine, but the browser refused it: the browser is right.
    const refused = judgeInstall(
      facts({
        csp: ["default-src *"],
        elements: [{ deployment: "dep-1", rendered: false }],
        messages: [
          `Refused to load the script '${CONSOLE}/arag-chat.js' because it violates the following Content Security Policy directive`,
        ],
      }),
      deployment,
    );
    assert.deepEqual(failing(refused), ["Content Security Policy"]);
    // Rendered, but the zone isn't in connect-src: questions will still fail.
    const noZone = judgeInstall(facts({ csp: [`connect-src ${CONSOLE}`] }), deployment);
    assert.match(noZone.find((c) => c.label === "Content Security Policy")!.detail, /aws-us-east-2-1/);
  });

  it("says when the domain lock hasn't applied yet, and doesn't call it all good", () => {
    const checks = judgeInstall(facts({ elements: [{ deployment: "dep-1", rendered: true }] }), { ...deployment, lockApplied: false });
    const domain = checks.find((c) => c.label === "Domain allowed")!;
    assert.equal(domain.result, "warn");
    assert.match(domain.detail, /still applying it/);
  });

  it("explains pages the chat stays off on purpose", () => {
    const excluded = judgeInstall(
      facts({ url: "https://www.client.com/private/x", finalUrl: "https://www.client.com/private/x", elements: [] }),
      { ...deployment, exclude: ["/private/*"] },
    );
    assert.deepEqual(failing(excluded), []);
    assert.match(excluded.find((c) => c.label === "Widget shows")!.detail, /Left out on purpose by \/private\/\*/);
    const editor = judgeInstall(facts({ finalUrl: "https://www.client.com/about/Action/Edit", elements: [] }), deployment);
    assert.deepEqual(failing(editor), []);
    assert.match(editor.at(-1)!.detail, /Sitefinity's page editor/);
    assert.equal(judgeInstall(facts({ bodyClasses: ["sfPageEditor"], elements: [] }), deployment).at(-1)!.label, "Widget shows");
  });

  it("has nothing to check before provisioning", () => {
    const checks = judgeInstall(facts(), { ...deployment, provisioned: false });
    assert.deepEqual(failing(checks), ["Not ready yet"]);
  });

  it("reports a page that didn't load, and nothing else", () => {
    assert.deepEqual(failing(judgeInstall(facts({ status: 0, error: "net::ERR_NAME_NOT_RESOLVED" }), deployment)), ["Page loads"]);
  });
});

describe("countsFromBody", () => {
  it("counts known events with one breakdown each, and ignores text and junk", () => {
    const body = JSON.stringify({
      events: [
        { name: "arag_chat_answer", conversation_id: "c", answered: true, question: "my email is a@b.co" },
        { name: "arag_chat_answer", conversation_id: "c", answered: false },
        { name: "arag_chat_answer", conversation_id: "d", answered: true },
        { name: "arag_chat_cta_click", conversation_id: "c", cta_label: "Book a visit" },
        { name: "arag_chat_feedback", value: "sideways" },
        { name: "made_up_event" },
      ],
    });
    const counts = [...countsFromBody(body).values()];
    assert.deepEqual(counts, [
      { name: "arag_chat_answer", dimension: "answered", count: 2 },
      { name: "arag_chat_answer", dimension: "unanswered", count: 1 },
      { name: "arag_chat_cta_click", dimension: "Book a visit", count: 1 },
      { name: "arag_chat_feedback", dimension: "", count: 1 },
    ]);
    assert.equal(countsFromBody("not json").size, 0);
  });
});

describe("parseLead", () => {
  const settings = {
    settings: { lead: { enabled: true, fields: ["name", "email", "phone", "message"], requiredFields: ["email"] } },
    language: "en",
  } as never;

  it("takes a consented lead with the allowed fields", () => {
    const parsed = parseLead(
      {
        consent: true,
        conversation_id: "c1",
        fields: { name: " Pat ", email: "pat@client.com", bogus: "x" },
        page_url: "https://www.client.com/visit",
      },
      settings,
    );
    assert.ok("value" in parsed);
    assert.deepEqual(parsed.value.fields, { name: "Pat", email: "pat@client.com" });
    assert.equal(parsed.value.pageUrl, "https://www.client.com/visit");
  });

  it("refuses without consent, a required field, or with the form off", () => {
    assert.ok("error" in parseLead({ consent: false, fields: { email: "pat@client.com" } }, settings));
    assert.ok("error" in parseLead({ consent: true, fields: { name: "Pat" } }, settings));
    assert.ok("error" in parseLead({ consent: true, fields: { email: "not an email" } }, settings));
    assert.ok(
      "error" in
        parseLead({ consent: true, fields: { email: "pat@client.com" } }, {
          settings: { lead: { enabled: false } },
          language: "en",
        } as never),
    );
  });
});

describe("report", () => {
  it("groups wordings of the same question", () => {
    const groups = groupQuestions([
      { question: "What are your hours?", answered: true },
      { question: "what are your hours", answered: false },
      { question: "Do you take walk-ins?", answered: true },
    ]);
    assert.deepEqual(groups[0], { question: "What are your hours?", count: 2, answered: 1 });
    assert.equal(groups.length, 2);
  });

  it("says quality in plain words", () => {
    assert.match(qualityWords(4.4, 4.0), /very good.*better than the month before/);
    assert.match(qualityWords(null, null), /Not enough/);
  });
});

describe("verifyIdToken", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const now = Date.UTC(2026, 9, 30, 12);
  const token = (claims: Record<string, unknown>, kid = "k1") => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
  };
  const good = {
    iss: "https://login.example",
    aud: "client-1",
    exp: now / 1000 + 600,
    nonce: "n1",
    sub: "u1",
    email: "Pat@Agency.example",
    name: "Pat",
  };
  const expected = { issuer: "https://login.example", audience: "client-1", nonce: "n1", keys: [jwk], now };

  it("accepts a valid token and lower-cases the email", () => {
    assert.deepEqual(verifyIdToken(token(good), expected), { subject: "u1", email: "pat@agency.example", name: "Pat" });
  });

  it("refuses a forged, foreign, stale or replayed token", () => {
    const forged = `${token(good).split(".").slice(0, 2).join(".")}.${Buffer.from("nope").toString("base64url")}`;
    assert.throws(() => verifyIdToken(forged, expected), OidcError);
    assert.throws(() => verifyIdToken(token({ ...good, aud: "other" }), expected), /another application/);
    assert.throws(() => verifyIdToken(token({ ...good, iss: "https://evil.example" }), expected), /another issuer/);
    assert.throws(() => verifyIdToken(token({ ...good, exp: now / 1000 - 600 }), expected), /expired/);
    assert.throws(() => verifyIdToken(token({ ...good, nonce: "other" }), expected), /nonce/);
    assert.throws(() => verifyIdToken(token({ ...good, email_verified: false }), expected), /verified/);
  });

  it("signs in end to end: discovery, code exchange with PKCE, and the verified token", async () => {
    const calls: { url: string; body?: string }[] = [];
    const idp = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? String(init.body) : undefined });
      if (u.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://login.example",
          authorization_endpoint: "https://login.example/auth",
          token_endpoint: "https://login.example/token",
          jwks_uri: "https://login.example/jwks",
        });
      }
      if (u === "https://login.example/token") return Response.json({ id_token: token(good) });
      if (u === "https://login.example/jwks") return Response.json({ keys: [jwk] });
      return new Response(null, { status: 404 });
    };
    const config = {
      issuer: "https://login.example",
      clientId: "client-1",
      clientSecret: "s",
      redirectUri: "https://console/auth/callback",
    };
    const identity = await completeSignIn(config, "code-1", { nonce: "n1", verifier: "v".repeat(48) }, idp as typeof fetch, now);
    assert.equal(identity.email, "pat@agency.example");
    const exchange = new URLSearchParams(calls.find((c) => c.url.endsWith("/token"))!.body);
    assert.equal(exchange.get("code"), "code-1");
    assert.equal(exchange.get("code_verifier"), "v".repeat(48));
    assert.equal(exchange.get("redirect_uri"), "https://console/auth/callback");
  });

  it("makes a standard S256 PKCE challenge", () => {
    // RFC 7636, appendix B.
    assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
