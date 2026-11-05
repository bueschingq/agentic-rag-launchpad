import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeCardNumber, parseCustomerForm } from "../src/lib/customer-form.ts";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const valid = {
  name: " Harbor View Dental ",
  displayName: "Harbor View Dental",
  language: "es",
  budget: "250.5",
  "contacts.0.name": "Ana Ruiz",
  "contacts.0.email": "Ana@Harborview.example",
  "contacts.0.kbRole": "contributor",
  "contacts.3.name": "Sam Lee",
  "contacts.3.email": "sam@harborview.example",
  "contacts.3.language": "en",
  primary: "3",
  "billing.method": "invoice",
  "billing.terms": "net_30",
  "billing.city": "Portland",
  "billing.poNumber": "PO-2291",
};

describe("parseCustomerForm", () => {
  it("reads the customer, contacts with gaps in their indexes, and billing", () => {
    const parsed = parseCustomerForm(form(valid));
    assert.ok("value" in parsed);
    const { value } = parsed;
    assert.equal(value.name, "Harbor View Dental");
    assert.equal(value.language, "es");
    assert.equal(value.monthlyBudgetCents, 25050);
    assert.deepEqual(
      value.contacts.map((c) => [c.name, c.email, c.language, c.kbRole, c.isPrimary]),
      [
        ["Ana Ruiz", "ana@harborview.example", "es", "contributor", false],
        ["Sam Lee", "sam@harborview.example", "en", null, true],
      ],
    );
    assert.deepEqual(value.billing, { address: { city: "Portland" }, method: "invoice", terms: "net_30", poNumber: "PO-2291" });
  });

  it("makes the first contact primary when none is picked, and skips blank rows", () => {
    const parsed = parseCustomerForm(
      form({ name: "Acme", displayName: "Acme", "contacts.0.name": "Jo", "contacts.0.email": "jo@acme.example", "contacts.1.name": "" }),
    );
    assert.ok("value" in parsed);
    assert.equal(parsed.value.contacts.length, 1);
    assert.equal(parsed.value.contacts[0]!.isPrimary, true);
    assert.equal(parsed.value.monthlyBudgetCents, null);
    assert.deepEqual(parsed.value.billing, {});
  });

  it("copies the primary contact into billing when asked", () => {
    const parsed = parseCustomerForm(form({ ...valid, "billing.sameAsPrimary": "on", "billing.contactName": "ignored" }));
    assert.ok("value" in parsed);
    assert.equal(parsed.value.billing.contactName, "Sam Lee");
    assert.equal(parsed.value.billing.contactEmail, "sam@harborview.example");
  });

  it("names every field that is wrong", () => {
    const parsed = parseCustomerForm(
      form({
        name: "",
        language: "xx",
        budget: "-5",
        "contacts.0.name": "Ana",
        "contacts.0.email": "not-an-email",
        "contacts.1.name": "Ana again",
        "contacts.1.email": "ana@x.example",
        "contacts.2.name": "Dup",
        "contacts.2.email": "ANA@x.example",
        "contacts.2.kbRole": "admin",
        "billing.method": "cash",
        "billing.contactEmail": "nope",
      }),
    );
    assert.ok("errors" in parsed);
    assert.deepEqual(Object.keys(parsed.errors).sort(), [
      "billing.contactEmail",
      "billing.method",
      "budget",
      "contacts.0.email",
      "contacts.2.email",
      "contacts.2.kbRole",
      "displayName",
      "language",
      "name",
    ]);
  });

  it("needs the name visitors see, and keeps it even when it's the customer name", () => {
    const missing = parseCustomerForm(form({ ...valid, displayName: " " }));
    assert.ok("errors" in missing);
    assert.match(missing.errors.displayName!, /name visitors see/);
    const same = parseCustomerForm(form(valid));
    assert.ok("value" in same);
    // Stored as chosen, so nothing falls back to the internal name.
    assert.equal(same.value.displayName, "Harbor View Dental");
    const other = parseCustomerForm(form({ ...valid, name: "Crayola (UX review r3)", displayName: " Crayola " }));
    assert.ok("value" in other);
    assert.deepEqual([other.value.name, other.value.displayName], ["Crayola (UX review r3)", "Crayola"]);
  });

  it("needs at least one contact", () => {
    const parsed = parseCustomerForm(form({ name: "Acme" }));
    assert.ok("errors" in parsed);
    assert.ok(parsed.errors.contacts);
  });

  it("refuses card numbers anywhere in billing", () => {
    for (const field of ["billing.poNumber", "billing.externalRef", "billing.line1"]) {
      const parsed = parseCustomerForm(form({ ...valid, [field]: "card 4111 1111 1111 1111" }));
      assert.ok("errors" in parsed && parsed.errors[field]?.includes("card number"), field);
    }
  });
});

describe("looksLikeCardNumber", () => {
  it("spots test card numbers however they are written", () => {
    assert.ok(looksLikeCardNumber("4111111111111111"));
    assert.ok(looksLikeCardNumber("5555-5555-5555-4444"));
    assert.ok(looksLikeCardNumber("Amex 3782 822463 10005"));
  });

  it("leaves ordinary references alone", () => {
    assert.equal(looksLikeCardNumber("PO-2291"), false);
    assert.equal(looksLikeCardNumber("4111111111111112"), false); // fails Luhn
    assert.equal(looksLikeCardNumber("cus_Q8xZ71aB"), false);
    assert.equal(looksLikeCardNumber("+1 503 555 0142"), false);
  });
});
