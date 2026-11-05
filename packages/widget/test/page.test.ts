import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WidgetLead } from "@launchpad/theme";
import { type BatchTransport, consoleEvent, EventBatch, newConversationId, track } from "../src/analytics.ts";
import { captureAttribution, readAttribution } from "../src/attribution.ts";
import { leadBody, leadFields, validateLead } from "../src/lead.ts";
import { explain, loadConfig, UNPUBLISHED } from "../src/load.ts";
import { inSitefinityEditor, pathMatches } from "../src/page.ts";
import { ConversationStore, type StorageLike } from "../src/store.ts";

describe("pathMatches", () => {
  const suggested = ["/login", "/checkout/*", "/account/*"];

  it("keeps the widget off the pages a deployment excludes", () => {
    for (const path of ["/login", "/login/", "/LOGIN/reset", "/checkout/payment", "/account/orders/7"]) {
      assert.ok(pathMatches(path, suggested), path);
    }
    for (const path of ["/", "/loginhelp", "/products/checkout", "/accounts"]) assert.ok(!pathMatches(path, suggested), path);
  });

  it("matches culture prefixes and file types with wildcards", () => {
    assert.ok(pathMatches("/es/login", ["*/login"]));
    assert.ok(pathMatches("/page.aspx", ["*.aspx"]));
    assert.ok(!pathMatches("/anything", ["", "  "]));
  });
});

describe("inSitefinityEditor", () => {
  it("recognises the MVC and Web Forms page editor", () => {
    assert.ok(inSitefinityEditor({ pathname: "/home/Action/Edit", search: "" }));
    assert.ok(inSitefinityEditor({ pathname: "/en/products/action/edit/", search: "" }));
    assert.ok(inSitefinityEditor({ pathname: "/home", search: "", bodyClasses: ["sfPageEditor", "zeContentMode"] }));
    assert.ok(inSitefinityEditor({ pathname: "/tpl", search: "", bodyClasses: ["sfTemplateEditor"] }));
  });

  it("recognises the ASP.NET Core and Next.js renderers' editor", () => {
    assert.ok(inSitefinityEditor({ pathname: "/home", search: "?sfaction=edit" }));
    assert.ok(inSitefinityEditor({ pathname: "/home", search: "?culture=en&sfaction=Edit" }));
    assert.ok(inSitefinityEditor({ pathname: "/home", search: "", framedWithContainers: true }));
  });

  it("shows on published pages and in preview", () => {
    assert.ok(!inSitefinityEditor({ pathname: "/home", search: "" }));
    assert.ok(!inSitefinityEditor({ pathname: "/home/Action/Preview", search: "" }));
    assert.ok(!inSitefinityEditor({ pathname: "/home", search: "?sfaction=preview" }));
    assert.ok(!inSitefinityEditor({ pathname: "/edit-your-profile", search: "?action=edit" }));
  });
});

describe("console events", () => {
  it("keeps only counts and flags, with the conversation's id", () => {
    const event = consoleEvent("arag_chat_answer", {
      conversation_id: "c1",
      answered: false,
      sources: 0,
      duration_ms: 812,
      question_length: 40,
      language: "es",
    });
    assert.deepEqual(event, { name: "arag_chat_answer", conversation_id: "c1", answered: false, sources: 0, language: "es" });
    assert.equal(consoleEvent("arag_chat_source_click", { conversation_id: "c1", link_url: "https://a.example" }), undefined);
    assert.equal(consoleEvent("arag_chat_open", {}), undefined);
  });

  it("carries the question's hash to the console only, never to GA or the dataLayer", () => {
    const params = { conversation_id: "c1", answered: true, language: "en" };
    assert.deepEqual(consoleEvent("arag_chat_feedback", { ...params, value: "down", question_hash: "0123abcd0123abcd" }), {
      name: "arag_chat_feedback",
      conversation_id: "c1",
      answered: true,
      language: "en",
      value: "down",
      question_hash: "0123abcd0123abcd",
    });
    // The element passes the hash to consoleEvent alone; what track() is given reaches the page.
    const dataLayer: unknown[] = [];
    const seen: unknown[] = [];
    const target = new EventTarget();
    target.addEventListener("arag-chat:event", (e) => seen.push((e as CustomEvent).detail));
    track(target, { deploymentId: "d1", settings: { analytics: { googleAnalytics: true } } } as never, "arag_chat_answer", params, {
      dataLayer,
    });
    assert.doesNotMatch(JSON.stringify([dataLayer, seen]), /question_hash/);
  });

  it("sends a batch after a pause, and the rest with the beacon on leaving", async () => {
    const posts: string[] = [];
    const beacons: string[] = [];
    const transport: BatchTransport = {
      post: async (_url, body) => posts.push(body),
      beacon: (url, body) => (url.endsWith("/events") ? beacons.push(body) > 0 : false),
    };
    const batch = new EventBatch("https://console.example/api/public/deployments/d1/events", transport, 10);
    batch.add({ name: "arag_chat_open", conversation_id: "c1" });
    batch.add({ name: "arag_chat_question", conversation_id: "c1", language: "en" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(JSON.parse(posts[0]!), {
      events: [
        { name: "arag_chat_open", conversation_id: "c1" },
        { name: "arag_chat_question", conversation_id: "c1", language: "en" },
      ],
    });
    batch.add({ name: "arag_chat_feedback", conversation_id: "c1", value: "up" });
    batch.flush(true);
    assert.equal(beacons.length, 1);
    assert.equal(posts.length, 1);
    batch.flush(true);
    assert.equal(beacons.length, 1, "nothing left to send");
  });

  it("makes a fresh id per conversation", () => {
    assert.notEqual(newConversationId(), newConversationId());
    assert.match(newConversationId(), /^[0-9a-f-]{32,36}$/);
  });
});

describe("ConversationStore", () => {
  const memory = (): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it("keeps the conversation per deployment, trimmed", () => {
    const storage = memory();
    const store = new ConversationStore("d1", storage);
    const replies = Array.from({ length: 25 }, (_, i) => ({ question: `q${i}`, answer: "a".repeat(5000), answered: true, sources: [] }));
    store.save({ id: "c1", replies, history: [], open: true });
    const loaded = store.load()!;
    assert.equal(loaded.replies.length, 20);
    assert.equal(loaded.replies[0]?.question, "q5");
    assert.equal(loaded.replies[0]?.answer.length, 4000);
    assert.equal(loaded.open, true);
    assert.equal(new ConversationStore("d2", storage).load(), undefined);
  });

  it("shrugs off blocked or broken storage", () => {
    const broken: StorageLike = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = new ConversationStore("d1", broken);
    assert.equal(store.load(), undefined);
    assert.doesNotThrow(() => store.save({ id: "c", replies: [], history: [], open: false }));
    assert.equal(new ConversationStore("d1", undefined).load(), undefined);
  });
});

describe("lead form", () => {
  const lead: WidgetLead = { enabled: true, fields: ["message", "name", "email"], requiredFields: ["email"] };

  it("shows the chosen fields in a fixed order, and asks for an email and a message by default", () => {
    assert.deepEqual(leadFields(lead), [
      { field: "name", required: false },
      { field: "email", required: true },
      { field: "message", required: false },
    ]);
    assert.deepEqual(leadFields({ enabled: true, fields: [], requiredFields: [] }), [
      { field: "email", required: true },
      { field: "message", required: true },
    ]);
  });

  it("needs the required fields, a real email and the consent box", () => {
    assert.deepEqual(validateLead(lead, { email: "" }, false), { email: "fieldRequired", consent: "consentRequired" });
    assert.deepEqual(validateLead(lead, { email: "not-an-email" }, true), { email: "emailInvalid" });
    assert.deepEqual(validateLead({ ...lead, fields: ["phone"] }, { phone: "call me" }, true), { phone: "phoneInvalid" });
    assert.deepEqual(validateLead(lead, { email: "ana@clinic.example", name: " " }, true), {});
  });

  it("posts only the shown fields, the page without its query, and the transcript only when asked", () => {
    const body = leadBody(
      lead,
      { email: " ana@clinic.example ", phone: "+1 555", message: "Call me back" },
      {
        conversationId: "c1",
        pageUrl: "https://www.clinic.example/book?email=ana@clinic.example#top",
        language: "es",
        consentText: "Acepto que me contacten.",
        placement: "cta",
        ctaLabel: "Pedir presupuesto",
        attribution: { landingPage: "https://www.clinic.example/", utm_source: "linkedin" },
      },
    );
    assert.deepEqual(body, {
      conversation_id: "c1",
      fields: { email: "ana@clinic.example", message: "Call me back" },
      consent: true,
      consent_text: "Acepto que me contacten.",
      page_url: "https://www.clinic.example/book",
      language: "es",
      placement: "cta",
      cta_label: "Pedir presupuesto",
      attribution: { landingPage: "https://www.clinic.example/", utm_source: "linkedin" },
    });
    const withTranscript = leadBody(
      lead,
      { email: "a@b.co" },
      {
        conversationId: "c1",
        pageUrl: "https://a.example/",
        language: "en",
        consentText: "I agree.",
        placement: "header",
        transcript: [{ author: "USER", text: "Hi" }],
      },
    );
    assert.deepEqual(withTranscript.transcript, [{ author: "USER", text: "Hi" }]);
  });
});

describe("attribution", () => {
  it("keeps the landing page and referrer without their query, and only the campaign tags", () => {
    assert.deepEqual(
      readAttribution(
        "https://www.client.example/?utm_source=linkedin&utm_campaign=q4&email=x@y.z&name=Ana#top",
        "https://www.linkedin.com/feed/?trk=abc",
      ),
      {
        landingPage: "https://www.client.example/",
        referrer: "https://www.linkedin.com/feed/",
        utm_source: "linkedin",
        utm_campaign: "q4",
      },
    );
  });

  it("drops a tag that carries an email address", () => {
    assert.deepEqual(readAttribution("https://a.example/p?utm_term=x@y.z&gclid=Cj0K", ""), {
      landingPage: "https://a.example/p",
      gclid: "Cj0K",
    });
  });

  it("keeps the first page of the visit for the rest of the tab", () => {
    const data = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    captureAttribution("https://a.example/?utm_source=linkedin", "https://www.linkedin.com/", storage);
    assert.deepEqual(captureAttribution("https://a.example/pricing", "https://a.example/", storage), {
      landingPage: "https://a.example/",
      referrer: "https://www.linkedin.com/",
      utm_source: "linkedin",
    });
    assert.deepEqual(captureAttribution("https://a.example/p", "", undefined), { landingPage: "https://a.example/p" });
  });
});

describe("loadConfig", () => {
  const base = "https://console.partner.example";
  const config = { deploymentId: "d1" };
  const events = () => {
    const target = new EventTarget();
    return target;
  };

  it("tells a deployment waiting for sign-off from a config", async () => {
    const result = await loadConfig(base, "d1", {
      fetch: async () => Response.json({ published: false }),
      origin: "https://www.client.example",
    });
    assert.deepEqual(result, { unpublished: true });
    assert.equal(UNPUBLISHED, "[arag-chat] This chat isn't published yet: it shows once it's signed off in the console.");
  });

  it("returns the config", async () => {
    const result = await loadConfig(base, "d1", { fetch: async () => Response.json(config), origin: "https://www.client.example" });
    assert.deepEqual(result, { config });
  });

  it("names a refused origin when the console says so", async () => {
    const result = await loadConfig(base, "d1", {
      fetch: async () => Response.json({ error: "Origin not allowed" }, { status: 403 }),
      origin: "https://staging.client.example",
    });
    assert.deepEqual(result, { failure: { cause: "origin", origin: "https://staging.client.example" } });
    assert.match(
      explain({ cause: "origin", origin: "https://staging.client.example" }, base, "d1"),
      /staging\.client\.example.*allowed domains/,
    );
  });

  it("tells a CSP block from a refusal and from an unreachable console", async () => {
    const target = events();
    const csp = await loadConfig(base, "d1", {
      fetch: async () => {
        const violation = Object.assign(new Event("securitypolicyviolation"), {
          blockedURI: `${base}/api/public`,
          effectiveDirective: "connect-src",
        });
        target.dispatchEvent(violation);
        throw new TypeError("Failed to fetch");
      },
      events: target,
      origin: "https://www.client.example",
    });
    assert.deepEqual(csp, { failure: { cause: "csp", directive: "connect-src" } });

    let calls = 0;
    const refused = await loadConfig(base, "d1", {
      fetch: async () => {
        if (calls++ === 0) throw new TypeError("Failed to fetch"); // a 403 without CORS headers
        return new Response(null, { status: 200 }); // the opaque probe gets through
      },
      origin: "https://client.example",
    });
    assert.deepEqual(refused, { failure: { cause: "refused", origin: "https://client.example" } });

    const down = await loadConfig(base, "d1", {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      origin: "https://client.example",
    });
    assert.deepEqual(down, { failure: { cause: "unreachable" } });
    assert.match(explain({ cause: "csp", directive: "connect-src" }, base, "d1"), /Content Security Policy.*connect-src/);
    // One change to connect-src covers the console and Agentic RAG, so the hint names both.
    assert.match(explain({ cause: "csp", directive: "connect-src" }, base, "d1"), /connect-src directive, with the Agentic RAG address/);
    assert.doesNotMatch(explain({ cause: "csp", directive: "default-src" }, base, "d1"), /Agentic RAG/);
  });
});
