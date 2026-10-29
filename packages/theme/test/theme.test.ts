import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, ensureContrast, flatten, mix, parseColor, rotateHue, toHex } from "../src/color.ts";
import { widgetMode } from "../src/settings.ts";
import { defaultTheme, GLOSS_SHEEN, glossBase, resolveTheme, type ThemeTokens, toCssVariables } from "../src/tokens.ts";

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

  it("rotates hue and leaves greys alone", () => {
    const hue = (c: string, deg: number) => toHex(rotateHue(parseColor(c)!, deg));
    assert.equal(hue("#ff0000", 120), "#00ff00");
    assert.equal(hue("#ff0000", -120), "#0000ff");
    assert.equal(hue("#0f766e", 360), "#0f766e");
    assert.equal(hue("#808080", 90), "#808080");
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

describe("finish", () => {
  // onPrimary must pass at every point of the primary → gradientEnd fill.
  const passesAlong = ({ color, finish }: ThemeTokens) => {
    const [start, end, text] = [parseColor(color.primary)!, parseColor(finish.gradientEnd)!, parseColor(color.onPrimary)!];
    return [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].every((x) => contrastRatio(text, mix(start, end, x)) >= 4.5);
  };

  it("defaults to flat, with a derived gradient stop that passes", () => {
    assert.equal(defaultTheme.finish.style, "flat");
    assert.notEqual(defaultTheme.finish.gradientEnd, defaultTheme.color.primary);
    assert.ok(passesAlong(defaultTheme));
  });

  it("accepts the three finishes and nothing else", () => {
    for (const style of ["flat", "gloss", "gradient"] as const) {
      assert.equal(resolveTheme({ finish: { style } }).theme.finish.style, style);
    }
    const { theme, warnings } = resolveTheme({ finish: { style: "glitter" as "flat" } });
    assert.equal(theme.finish.style, "flat");
    assert.equal(warnings.length, 1);
  });

  it("re-derives the gradient stop from a new primary", () => {
    for (const primary of ["#0f766e", "#e30613", "#ffd000", "#7c3aed", "#9ca3af"]) {
      const { theme, warnings } = resolveTheme({ color: { primary }, finish: { style: "gradient" } });
      assert.notEqual(theme.finish.gradientEnd, defaultTheme.finish.gradientEnd, primary);
      assert.ok(passesAlong(theme), `${primary} → ${theme.finish.gradientEnd} on ${theme.color.onPrimary}`);
      assert.ok(!warnings.some((w) => w.startsWith("finish.")), "derived values don't warn");
    }
  });

  it("keeps a sniffed gradient stop that passes, and repairs one that doesn't", () => {
    const kept = resolveTheme({ color: { primary: "#0f766e" }, finish: { style: "gradient", gradientEnd: "#1e40af" } });
    assert.equal(kept.theme.finish.gradientEnd, "#1e40af");
    assert.deepEqual(kept.warnings, []);

    const fixed = resolveTheme({ color: { primary: "#0f766e" }, finish: { gradientEnd: "#a7f3d0" } });
    assert.notEqual(fixed.theme.finish.gradientEnd, "#a7f3d0");
    assert.ok(passesAlong(fixed.theme));
    assert.ok(fixed.warnings.some((w) => w.startsWith("finish.gradientEnd")));
  });

  it("deepens the gloss base only where the sheen would cost contrast", () => {
    const c = (s: string) => parseColor(s)!;
    const sheened = (base: string) => toHex(flatten({ r: 255, g: 255, b: 255, a: GLOSS_SHEEN }, c(base)));
    assert.equal(toHex(glossBase(c("#1f2937"), c("#ffffff"))), "#1f2937");
    assert.equal(toHex(glossBase(c("#f3f4f6"), c("#111827"))), "#f3f4f6", "dark text on a light fill only gains contrast");
    assert.equal(toHex(glossBase(c("#ffd000"), c("#000000"))), "#ffd000");

    const blue = glossBase(c("#0d6efd"), c("#ffffff"));
    assert.notEqual(toHex(blue), "#0d6efd");
    assert.ok(ratio("#ffffff", sheened(toHex(blue))) >= 4.5);
    assert.ok(blue.b > blue.r * 3, `still Bootstrap blue: ${toHex(blue)}`);
  });
});

describe("widgetMode", () => {
  it("passes the four modes through and falls back to floating", () => {
    for (const mode of ["embedded", "chat", "popup", "floating"]) assert.equal(widgetMode(mode), mode);
    assert.equal(widgetMode("overlay"), "floating");
    assert.equal(widgetMode(undefined), "floating");
  });
});

describe("toCssVariables", () => {
  it("emits one custom property per token", () => {
    const css = toCssVariables(defaultTheme);
    assert.match(css, /^:host \{/);
    assert.match(css, /--arag-chat-color-primary: #1f2937;/);
    assert.match(css, /--arag-chat-launcher-size: 56px;/);
    assert.match(css, /--arag-chat-gloss-base: #1f2937;/);
    assert.equal(css.match(/--arag-chat-/g)?.length, 24);
  });
});
