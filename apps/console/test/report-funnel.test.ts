// The client report's counts agree, with a funnel and a CSV (round 7: "1 contact form" above "Contact
// form: 2", and "en: 49" for 83 questions). Seeded as the demo's October report read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCsv } from "../src/lib/metrics.ts";
import { contactClicks, languageCounts, reportFunnel, reportRows } from "../src/lib/report.ts";

const october = {
  month: "2026-10",
  opens: 120,
  questions: 83,
  logged: 83,
  answered: 70,
  unanswered: 13,
  leads: 1,
  ctas: [{ label: "Request a quote", count: 4 }],
  handoffs: [
    { label: "form", count: 2 },
    { label: "phone", count: 1 },
    { label: "link", count: 1 },
  ],
  languages: [{ label: "en", count: 49 }],
  thumbs: { up: 5, down: 1 },
  test: { questions: 12, included: false },
  top: [{ question: "=SUM(A1) what are your hours?", count: 3, answered: 2 }],
  gaps: [{ question: "Do you ship to Mars?", count: 1, answered: 0 }],
  notHelpful: [],
};

describe("the report's counts", () => {
  it("a form sent is a lead, and a click on its button isn't counted as one", () => {
    assert.equal(contactClicks(october), 2);
    assert.equal(october.leads + contactClicks(october), 3);
  });

  it("the languages add up to the questions", () => {
    const rows = languageCounts(october);
    assert.deepEqual(rows.at(-1), { label: "Not recorded", count: 34 });
    assert.equal(
      rows.reduce((n, r) => n + r.count, 0),
      october.questions,
    );
    assert.deepEqual(languageCounts({ languages: [{ label: "en", count: 83 }], questions: 83 }), [{ label: "en", count: 83 }]);
  });

  it("the funnel runs opened, asked, answered, clicked, lead, from the report's own counts", () => {
    assert.deepEqual(reportFunnel(october), [
      { label: "Chats opened", count: 120 },
      { label: "Questions asked", count: 83 },
      { label: "Answered from the site", count: 70 },
      { label: "Buttons and contacts clicked", count: 6 },
      { label: "Leads sent", count: 1 },
    ]);
  });
});

describe("the report's CSV", () => {
  const csv = toCsv(reportRows(october));

  it("holds the funnel and the lists, in the same counts", () => {
    assert.match(csv, /^Section,Item,Count,Unanswered\r\n/);
    assert.match(csv, /Funnel,Questions asked,83,\r\n/);
    assert.match(csv, /Funnel,Leads sent,1,\r\n/);
    assert.match(csv, /Language,Not recorded,34,\r\n/);
    assert.match(csv, /Contact used,Contact form opened,2,\r\n/);
    assert.match(csv, /Content gap,Do you ship to Mars\?,1,1\r\n/);
    assert.match(csv, /Test traffic \(not counted\),Questions,12,\r\n/);
  });

  it("a question can't run as a formula", () => {
    assert.match(csv, /Asked most,'=SUM\(A1\) what are your hours\?,3,1\r\n/);
  });

  it("has no cost in it", () => {
    assert.doesNotMatch(csv, /cost/i);
  });
});
