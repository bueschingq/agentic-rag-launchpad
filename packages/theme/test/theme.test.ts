import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, ensureContrast, parseColor, toHex } from "../src/color.ts";
import { defaultTheme, resolveTheme, toCssVariables } from "../src/tokens.ts";

const ratio = (a: string, b: string) => contrastRatio(parseColor(a)!, parseColor(b)!);

describe("color", () => {
  it("parses the formats getComputedStyle and partners produce", () => {
    assert.deepEqual(parseColor("#0af"), { r: 0, g: 170, b: 255, a: 1 });
    assert.deepEqual(parseColor("#2B2BB2"), { r: 43, g: 43, b: 178, a: 1 });
    assert.deepEqual(parseColor("rgb(43, 43, 178)"), { r: 43, g: 43, b: 178, a: 1 });
    assert.deepEqual(parseColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
    assert.deepEqual(parseColor("rgb(255 255 255 / 50%)"), { r: 255, g: 255, b: 255, a: 0.5 });
    assert.equal(parseColor("white")?.r, 255);
    assert.equal(parseColor("var(--brand)"), undefined);
    assert.equal(parseColor("red; background: url(x)"), undefined);
  });

  it("measures WCAG contrast", () => {
    assert.equal(ratio("#000", "#fff").toFixed(1), "21.0");
    assert.equal(ratio("#fff", "#fff"), 1);
    assert.ok(ratio("#767676", "#fff") >= 4.5);
    assert.ok(ratio("#777777", "#fff") < 4.5);
  });

  it("repairs low contrast while keeping the hue", () => {
    const fixed = ensureContrast(parseColor("#7fb3ff")!, parseColor("#ffffff")!, 4.5);
    assert.ok(contrastRatio(fixed, parseColor("#ffffff")!) >= 4.5);
    assert.ok(fixed.b > fixed.r, `still blue-ish: ${toHex(fixed)}`);
  });
});

describe("resolveTheme", () => {
  it("ships an AA-compliant default", () => {
    const { theme, warnings } = resolveTheme();
    assert.deepEqual(warnings, []);
    assert.deepEqual(theme, defaultTheme);
  });

  it("normalises colors and keeps valid partner values", () => {
    const { theme, warnings } = resolveTheme({
      color: { primary: "rgb(0, 82, 155)" },
      font: { family: '"Source Sans Pro", Arial, sans-serif' },
      shape: { buttonRadius: "999px" },
    });
    assert.deepEqual(warnings, []);
    assert.equal(theme.color.primary, "#00529b");
    assert.equal(theme.font.family, '"Source Sans Pro", Arial, sans-serif');
    assert.equal(theme.shape.buttonRadius, "999px");
  });

  it("drops values that could break out of the stylesheet", () => {
    const { theme, warnings } = resolveTheme({
      font: { family: "Arial; } body { display:none } :host {" },
      shape: { shadow: "0 0 1px red; background: url(https://evil.example)" },
      color: { link: "expression(alert(1))" },
      launcher: { size: "calc(100vw)" },
    });
    assert.equal(theme.font.family, defaultTheme.font.family);
    assert.equal(theme.shape.shadow, defaultTheme.shape.shadow);
    assert.equal(theme.color.link, defaultTheme.color.link);
    assert.equal(theme.launcher.size, defaultTheme.launcher.size);
    assert.equal(warnings.length, 4);
  });

  it("fixes failing contrast and says what it changed", () => {
    const { theme, warnings } = resolveTheme({ color: { primary: "#ffd000", onPrimary: "#ffffff", text: "#aaaaaa" } });
    assert.equal(theme.color.onPrimary, "#000000");
    assert.ok(ratio(theme.color.text, theme.color.surface) >= 4.5);
    assert.ok(warnings.some((w) => w.startsWith("color.onPrimary")));
    assert.ok(warnings.some((w) => w.startsWith("color.text")));
  });
});

describe("toCssVariables", () => {
  it("emits one custom property per token", () => {
    const css = toCssVariables(defaultTheme);
    assert.match(css, /^:host \{/);
    assert.match(css, /--arag-chat-color-primary: #1f2937;/);
    assert.match(css, /--arag-chat-launcher-size: 56px;/);
    assert.equal(css.match(/--arag-chat-/g)?.length, 20);
  });
});
