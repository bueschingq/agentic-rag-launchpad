import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSettingsForm } from "../src/lib/settings-form.ts";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe("parseSettingsForm", () => {
  it("reads trimmed values and treats an empty rate as none", () => {
    assert.deepEqual(parseSettingsForm(form({ partnerName: " Northwind ", rate: "0.25", markupPercent: "35" })), {
      value: { partnerName: "Northwind", rate: 0.25, markupPercent: 35 },
    });
    assert.deepEqual(parseSettingsForm(form({ partnerName: "", rate: " ", markupPercent: "" })), {
      value: { partnerName: "", rate: undefined, markupPercent: 0 },
    });
  });

  it("names the field that is wrong", () => {
    assert.deepEqual(parseSettingsForm(form({ rate: "-1" })), { error: "rate" });
    assert.deepEqual(parseSettingsForm(form({ rate: "abc" })), { error: "rate" });
    assert.deepEqual(parseSettingsForm(form({ rate: "Infinity" })), { error: "rate" });
    assert.deepEqual(parseSettingsForm(form({ markupPercent: "2000" })), { error: "markupPercent" });
    assert.deepEqual(parseSettingsForm(form({ partnerName: "x".repeat(121) })), { error: "partnerName" });
  });
});
