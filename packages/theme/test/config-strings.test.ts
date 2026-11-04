import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allWidgetStrings, configStrings, englishStrings, LANGUAGES, widgetStrings } from "../src/index.ts";

describe("configStrings", () => {
  it("sends only a fixed language's text", () => {
    assert.deepEqual(Object.keys(configStrings("de", ["de", "fr"])), ["de"]);
    assert.equal(configStrings("de").de?.welcome, widgetStrings("de").welcome);
  });

  it("sends nothing for English, which is in the bundle", () => {
    assert.deepEqual(configStrings("en"), {});
    assert.equal(widgetStrings("en"), englishStrings);
  });

  it("sends the served languages for auto, less English", () => {
    assert.deepEqual(Object.keys(configStrings("auto", ["en", "es"])), ["es"]);
  });

  it("sends every language for auto with none served, since any browser language can win", () => {
    assert.equal(Object.keys(configStrings("auto")).length, LANGUAGES.length - 1);
    assert.equal(Object.keys(allWidgetStrings()).length, LANGUAGES.length);
  });
});
