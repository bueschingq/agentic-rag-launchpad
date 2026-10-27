import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientIp, isAllowedOrigin, RateLimiter } from "../src/lib/origin.ts";

const domains = ["https://www.acme.com", "https://staging.acme.com/"];

describe("isAllowedOrigin", () => {
  it("matches scheme, host and port exactly", () => {
    assert.equal(isAllowedOrigin("https://www.acme.com", domains), true);
    assert.equal(isAllowedOrigin("https://staging.acme.com", domains), true);
    assert.equal(isAllowedOrigin("http://www.acme.com", domains), false);
    assert.equal(isAllowedOrigin("https://www.acme.com:8443", domains), false);
    assert.equal(isAllowedOrigin("https://acme.com", domains), false);
  });

  it("rejects look-alikes and non-origins", () => {
    assert.equal(isAllowedOrigin("https://www.acme.com.evil.example", domains), false);
    assert.equal(isAllowedOrigin("https://evil.example/https://www.acme.com", domains), false);
    assert.equal(isAllowedOrigin("https://www.acme.com/", domains), false, "browsers never send a path");
    assert.equal(isAllowedOrigin("null", domains), false);
    assert.equal(isAllowedOrigin(null, domains), false);
    assert.equal(isAllowedOrigin("javascript:alert(1)", ["javascript:alert(1)"]), false);
  });
});

describe("RateLimiter", () => {
  it("allows max requests per window, per key", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    assert.deepEqual([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")], [true, true, false]);
    assert.equal(limiter.allow("b"), true);
    now = 60_000;
    assert.equal(limiter.allow("a"), true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded address", () => {
    assert.equal(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" })), "203.0.113.7");
    assert.equal(clientIp(new Headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
    assert.equal(clientIp(new Headers()), "unknown");
  });
});
