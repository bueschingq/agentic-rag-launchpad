import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "@launchpad/theme";
import { buttonPaint, deriveTheme } from "../src/derive.ts";
import type { RawStyles } from "../src/extract.ts";

// Roughly what a Bootstrap-based Sitefinity site reports.
const raw: RawStyles = {
  rootVars: { "--bs-primary": "#0d6efd", "--bs-body-font-family": "Lato, sans-serif" },
  body: {
    color: "rgb(33, 37, 41)",
    background: "rgb(255, 255, 255)",
    fontFamily: "Lato, sans-serif",
    fontSize: "16px",
    lineHeight: "24px",
  },
  heading: { fontFamily: '"Playfair Display", serif', color: "rgb(0, 0, 0)" },
  linkColor: "rgb(0, 82, 155)",
  buttons: [
    {
      text: "Menu",
      background: "rgb(248, 249, 250)",
      backgroundImage: "none",
      color: "rgb(0, 0, 0)",
      borderRadius: "4px",
      fontWeight: "400",
      boxShadow: "none",
      width: 80,
      height: 32,
      count: 6,
    },
    {
      text: "Shop now",
      background: "rgb(227, 6, 19)",
      backgroundImage: "none",
      color: "rgb(255, 255, 255)",
      borderRadius: "24px",
      fontWeight: "700",
      boxShadow: "none",
      width: 160,
      height: 48,
      count: 4,
    },
  ],
  input: { borderColor: "rgb(206, 212, 218)", borderRadius: "6px" },
  loadedFonts: ["Lato", "Playfair Display"],
  icons: [],
};

describe("deriveTheme", () => {
  it("takes the primary color from the dominant brand-colored CTA, not grey UI buttons", () => {
    const { input, confidence, sources } = deriveTheme(raw);
    assert.equal(input.color?.primary, "#e30613");
    assert.equal(input.color?.onPrimary, "#ffffff");
    assert.equal(confidence["color.primary"], 0.9);
    assert.equal(sources["color.primary"], 'button "Shop now" ×4');
  });

  it("keeps pill buttons as pills and derives sane panel corners", () => {
    const { input } = deriveTheme(raw);
    assert.equal(input.shape?.buttonRadius, "999px");
    assert.equal(input.shape?.radius, "16px");
    assert.equal(input.shape?.inputRadius, "6px");
  });

  it("uses the site's fonts only when they actually loaded", () => {
    assert.equal(deriveTheme(raw).input.font?.family, "Lato, sans-serif");
    assert.equal(deriveTheme(raw).input.font?.headingFamily, '"Playfair Display", serif');
    assert.equal(deriveTheme({ ...raw, loadedFonts: [] }).input.font?.family, undefined);
    assert.equal(deriveTheme(raw).input.font?.lineHeight, "1.50");
  });

  it("falls back to a brand custom property when there is no CTA", () => {
    const { input, sources } = deriveTheme({ ...raw, buttons: [] });
    assert.equal(input.color?.primary, "#0d6efd");
    assert.equal(sources["color.primary"], "--bs-primary");
  });

  it("reads the finish off the CTA's background", () => {
    const cta = raw.buttons[1]!;
    const withCta = (patch: Partial<typeof cta>) => deriveTheme({ ...raw, buttons: [{ ...cta, ...patch }] });

    const flat = deriveTheme(raw);
    assert.equal(flat.input.finish?.style, "flat");
    assert.equal(flat.confidence["finish.style"], 0.6);

    // Gradient buttons usually report a transparent background-color.
    const gradient = withCta({
      background: "rgba(0, 0, 0, 0)",
      backgroundImage: "linear-gradient(90deg, rgb(124, 58, 237) 0%, rgb(219, 39, 119) 100%)",
    });
    assert.equal(gradient.input.color?.primary, "#7c3aed");
    assert.equal(gradient.input.finish?.style, "gradient");
    assert.equal(gradient.input.finish?.gradientEnd, "#db2777");

    const gloss = withCta({ backgroundImage: "linear-gradient(rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0) 50%)" });
    assert.equal(gloss.input.color?.primary, "#e30613");
    assert.equal(gloss.input.finish?.style, "gloss");
  });

  it("treats a gradient between near-identical stops as flat", () => {
    const paint = buttonPaint({ ...raw.buttons[1]!, backgroundImage: "linear-gradient(rgb(227, 6, 19), rgb(230, 8, 20))" });
    assert.equal(paint.finish, "flat");
  });

  it("produces a theme that survives sanitising and contrast checks", () => {
    const { theme, warnings } = resolveTheme(deriveTheme(raw).input);
    assert.deepEqual(warnings, []);
    assert.equal(theme.color.primary, "#e30613");
  });
});
