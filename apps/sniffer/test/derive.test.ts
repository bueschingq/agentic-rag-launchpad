import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "@launchpad/theme";
import { deriveTheme } from "../src/derive.ts";
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

  it("produces a theme that survives sanitising and contrast checks", () => {
    const { theme, warnings } = resolveTheme(deriveTheme(raw).input);
    assert.deepEqual(warnings, []);
    assert.equal(theme.color.primary, "#e30613");
  });
});
