import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWidgetSettings, resolveTheme, type ThemeInput, type WidgetSettings } from "@launchpad/theme";
import { changedSinceSignOff, fieldWords, widgetDiff } from "../src/lib/widget-diff.ts";

// A saved deployment as the database returns it: jsonb sorts an object's keys (shorter first),
// so the same values come back in another order than the configurator posts them.
const saved: { theme: ThemeInput; settings: WidgetSettings } = {
  theme: { color: { primary: "#E2231A" }, shape: { radius: "12px" } },
  settings: {
    mode: "floating",
    ctas: [{ url: "https://www.crayola.com/shop", label: "Shop", keywords: ["buy", "shop"] }],
    welcome: "Hi! Ask about Crayola.",
    language: "en",
    nickname: "Crayola Help",
    starters: ["Where can I buy crayons?"],
    handoff: { show: ["no-answer"], contacts: [{ url: "https://www.crayola.com/contact", kind: "link" }] },
    showSources: true,
  },
};

// What the configurator posts back on Save: every theme token resolved, keys in its own order,
// the language left to the deployment, defaults spelled out, an empty list where there was none.
function posted(settings: Partial<WidgetSettings> = {}) {
  const { language: _, ...rest } = saved.settings;
  return {
    theme: resolveTheme(saved.theme).theme as ThemeInput,
    settings: {
      showSources: true,
      poweredBy: false,
      ...rest,
      handoff: { contacts: [{ kind: "link" as const, url: "https://www.crayola.com/contact" }], show: ["no-answer" as const] },
      ctas: [{ label: "Shop", url: "https://www.crayola.com/shop", keywords: ["buy", "shop"] }],
      exclude: [],
      ...settings,
    },
  };
}

describe("the widget save's diff", () => {
  it("lists nothing when nothing visitors get changed, whatever order the JSON is in", () => {
    assert.deepEqual(widgetDiff(saved, posted()).changed, []);
    // The defaults are what the widget shows anyway.
    assert.deepEqual(widgetDiff(saved, posted({ feedback: defaultWidgetSettings.feedback })).changed, []);
  });

  it("lists only the welcome message when only the welcome message changed (the marketer's round-3 case)", () => {
    const diff = widgetDiff(saved, posted({ welcome: "Hello! What can we help you find?" }));
    assert.deepEqual(diff.changed, ["settings.welcome"]);
    assert.equal(fieldWords(diff.changed), "the welcome message");
    const [before, after] = diff.hashes["settings.welcome"]!;
    assert.notEqual(before, after);
    assert.doesNotMatch(JSON.stringify(diff), /Hello|Crayola/, "no values in the audit log");
  });

  it("names a theme token, and the color it follows, in a partner's words", () => {
    const diff = widgetDiff(saved, { ...posted(), theme: { ...saved.theme, color: { primary: "#1A4D8F" } } });
    assert.ok(diff.changed.includes("theme.color.primary"), diff.changed.join(", "));
    assert.ok(!diff.changed.includes("theme.finish.gradientEnd"), "the gradient stop shows only with the gradient finish");
    assert.equal(fieldWords(diff.changed), "the primary color");
    assert.deepEqual(widgetDiff(saved, { ...posted(), theme: { ...saved.theme, color: { primary: "#e2231a" } } }).changed, []);
    assert.equal(fieldWords(["settings.nickname", "settings.ctas", "theme.font.family"]), "the chat name, the buttons and the font");
    // Saves recorded before tokens were told apart.
    assert.equal(fieldWords(["theme.color"]), "the theme");
  });

  it("drops a field changed and changed back from what differs since sign-off", () => {
    const first = widgetDiff(saved, posted({ welcome: "Hello!" }));
    const second = widgetDiff(
      { theme: saved.theme, settings: { ...saved.settings, welcome: "Hello!" } },
      posted({ welcome: "Hello!", nickname: "Crayola Helper" }),
    );
    const back = widgetDiff(
      { theme: saved.theme, settings: { ...saved.settings, welcome: "Hello!", nickname: "Crayola Helper" } },
      posted({ nickname: "Crayola Helper" }),
    );
    assert.deepEqual(first.changed, ["settings.welcome"]);
    assert.deepEqual(second.changed, ["settings.nickname"]);
    assert.deepEqual(back.changed, ["settings.welcome"]);
    assert.deepEqual([...changedSinceSignOff([first, second, back])], ["settings.nickname"]);
    // An entry from before the hashes: still listed.
    assert.deepEqual([...changedSinceSignOff([{ changed: ["settings.ctas"] }, first])].sort(), ["settings.ctas", "settings.welcome"]);
  });
});
