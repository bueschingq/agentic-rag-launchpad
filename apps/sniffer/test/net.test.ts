import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPublicUrl, isPublicAddress, safeFetchText, UnsafeUrlError } from "../src/net.ts";

describe("isPublicAddress", () => {
  it("blocks private, loopback, link-local and reserved IPv4", () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.31.255.255",
      "192.168.0.10",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["104.16.9.34", "8.8.8.8", "172.32.0.1", "11.0.0.1"]) assert.equal(isPublicAddress(ip), true, ip);
  });

  it("blocks private IPv6, including IPv4 smuggled inside", () => {
    for (const ip of [
      "::",
      "::1",
      "fd00::1",
      "fe80::1%en0",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
      "2002:c0a8:0101::1",
    ]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700::6810:922", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      assert.equal(isPublicAddress(ip), true, ip);
    }
    assert.equal(isPublicAddress("64:ff9b:1::a9fe:a9fe"), true, "local-use NAT64 prefix is not the well-known one");
  });

  it("rejects garbage", () => {
    assert.equal(isPublicAddress("not-an-ip"), false);
    assert.equal(isPublicAddress("1:2:3"), false);
  });
});

describe("assertPublicUrl", () => {
  const resolve = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it("accepts public http(s) URLs", async () => {
    const url = await assertPublicUrl("https://www.crayola.com/", resolve({ "www.crayola.com": ["104.18.1.1"] }));
    assert.equal(url.hostname, "www.crayola.com");
  });

  it("rejects hosts that resolve anywhere private", async () => {
    await assert.rejects(
      assertPublicUrl("https://sneaky.example/", resolve({ "sneaky.example": ["104.18.1.1", "10.0.0.5"] })),
      UnsafeUrlError,
    );
    await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /private or reserved/);
    await assert.rejects(assertPublicUrl("http://[::1]/"), /private or reserved/);
  });

  it("rejects other schemes, ports, credentials and internal names", async () => {
    await assert.rejects(assertPublicUrl("file:///etc/passwd"), /Only http and https/);
    await assert.rejects(assertPublicUrl("https://example.com:5432/"), /standard ports/);
    await assert.rejects(assertPublicUrl("https://user:pw@example.com/"), /credentials/);
    await assert.rejects(assertPublicUrl("http://postgres.internal/"), /Internal host/);
    await assert.rejects(assertPublicUrl("http://localhost/"), /Internal host/);
    await assert.rejects(assertPublicUrl("nope"), /Not a valid URL/);
  });
});

describe("safeFetchText", () => {
  const resolve = async (host: string) => (host === "public.example" ? ["93.184.216.34"] : ["10.0.0.9"]);

  it("re-checks every redirect hop", async () => {
    const fetchStub = (async (url: string) =>
      url.startsWith("https://public.example")
        ? new Response(null, { status: 302, headers: { location: "http://admin.example/secrets" } })
        : new Response("should never be fetched")) as typeof fetch;
    await assert.rejects(safeFetchText("https://public.example/robots.txt", { resolve, fetch: fetchStub }), /private or reserved/);
  });

  it("caps the response size", async () => {
    const fetchStub = (async () => new Response("x".repeat(2000))) as unknown as typeof fetch;
    await assert.rejects(safeFetchText("https://public.example/", { resolve, fetch: fetchStub, maxBytes: 1000 }), /larger than 1000 bytes/);
  });
});
