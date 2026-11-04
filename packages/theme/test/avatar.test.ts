import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avatarFit, type LogoCandidate, preferredAvatar } from "../src/index.ts";

const svg = "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E";
const og = (url: string): LogoCandidate => ({ url, source: "og:image", check: true });

describe("avatarFit", () => {
  it("tells a mark from a wordmark at the chat's size", () => {
    assert.equal(avatarFit({ url: svg, source: "header-home", width: 232, height: 26 }), "wide", "whatsupgold.com's header logo");
    assert.equal(avatarFit({ url: svg, source: "header-home", width: 147, height: 60 }), "wide", "telerik.com's");
    assert.equal(avatarFit({ url: svg, source: "header-home", width: 107, height: 25 }), "wide", "progress.com's");
    assert.equal(avatarFit({ url: "https://www.crayola.com/crayola.png", source: "header-home", width: 228, height: 149 }), "square");
    assert.equal(avatarFit({ url: "https://x.example/logo.png", source: "header-home", width: 90, height: 50 }), "fits");
    assert.equal(
      avatarFit({ url: "https://x.example/apple-touch-icon.png", source: "apple-touch-icon", width: 180, height: 180 }),
      "square",
    );
    assert.equal(avatarFit({ url: "https://x.example/favicon.ico", source: "icon", width: 16, height: 16 }), "small");
    assert.equal(avatarFit({ url: "https://x.example/icon.svg", source: "icon", width: 16, height: 16 }), "square", "an SVG scales");
    assert.equal(avatarFit({ url: "https://x.example/favicon.ico", source: "icon" }), "unknown");
  });
});

describe("preferredAvatar", () => {
  it("takes the site's icon over a wide header logo (telerik.com, progress.com/sitefinity-cms as scanned)", () => {
    const telerik: LogoCandidate[] = [
      { url: svg, source: "header-home", width: 147, height: 60 },
      { url: "https://www.telerik.com/favicon.ico?v=rebv1", source: "icon" },
      og("https://www.telerik.com/sfimages/default-source/logos/telerik1200x630.png"),
    ];
    // Its size wasn't measured then: offered, for a person to check.
    assert.deepEqual(preferredAvatar(telerik), { candidate: telerik[1], check: true });
    const measured = [telerik[0]!, { ...telerik[1]!, width: 48, height: 48 }, telerik[2]!];
    assert.deepEqual(preferredAvatar(measured), { candidate: measured[1], check: false });
  });

  it("prefers the home-screen icon, then the largest browser-tab icon", () => {
    const candidates: LogoCandidate[] = [
      { url: svg, source: "header-home", width: 195, height: 32 },
      { url: "https://www.chef.io/apple-touch-icon.png", source: "apple-touch-icon", width: 180, height: 180 },
      { url: "https://www.chef.io/icon-192.png", source: "icon", width: 192, height: 192 },
    ];
    assert.equal(preferredAvatar(candidates)?.candidate.source, "apple-touch-icon");
    assert.equal(preferredAvatar([candidates[0]!, candidates[2]!])?.candidate.url, "https://www.chef.io/icon-192.png");
  });

  it("keeps a header logo that reads at chat size", () => {
    const crayola: LogoCandidate[] = [
      { url: "https://www.crayola.com/crayola.png", source: "header-home", width: 228, height: 149 },
      { url: "https://www.crayola.com/apple-touch-icon.png", source: "apple-touch-icon", width: 180, height: 180 },
    ];
    assert.deepEqual(preferredAvatar(crayola), { candidate: crayola[0], check: false });
  });

  it("falls back to a wide logo, flagged, rather than a 16 px icon; never to og:image", () => {
    const wug: LogoCandidate[] = [
      { url: svg, source: "header-home", width: 232, height: 26 },
      { url: "https://www.whatsupgold.com/favicon.ico", source: "icon", width: 16, height: 16 },
      og("https://www.whatsupgold.com/images/social-image.png"),
    ];
    assert.deepEqual(preferredAvatar(wug), { candidate: wug[0], check: true });
    assert.equal(preferredAvatar([wug[2]!]), undefined);
    assert.equal(preferredAvatar([]), undefined);
  });
});
