import type { FetchLike } from "../src/http.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

// A fetch stand-in that records every call and answers from `respond`.
export function mockFetch(respond: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A JWT-shaped string with the given claims (signature is not checked client-side).
export function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJl`;
}

export const NUA_KEY = fakeJwt({
  iss: "https://aws-us-east-2-1.dp.progress.cloud/",
  sub: "11111111-1111-1111-1111-111111111111",
  key: "22222222-2222-2222-2222-222222222222",
  allow_kb_management: true,
});

// A stream that delivers `text` in the given chunk sizes, to exercise line splitting.
export function chunkedStream(text: string, sizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const size of sizes) {
        if (offset >= bytes.length) break;
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      }
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
}
