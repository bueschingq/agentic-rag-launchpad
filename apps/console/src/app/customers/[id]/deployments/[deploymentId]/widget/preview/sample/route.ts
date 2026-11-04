// Sample replies for the configurator's preview, without calling Agentic RAG. The widget sends
// its token as ?eph-token=; the preview sets it to "no-answer" to show the nothing-found reply.

import { resolveLanguage } from "@launchpad/theme";
import { sampleStream } from "@/lib/sample-answer.ts";
import { loadWidgetPage } from "@/lib/widget.ts";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

const CHUNK_DELAY_MS = 45;

export async function POST(request: Request, { params }: Params) {
  const { id, deploymentId } = await params;
  const page = await loadWidgetPage(id, deploymentId);
  if (!page) return new Response("Not found", { status: 404 });

  const kind = new URL(request.url).searchParams.get("eph-token") === "no-answer" ? "no-answer" : "answer";
  // "auto" previews in the partner's own browser language, as a visitor's would.
  const browser = (request.headers.get("accept-language") ?? "").split(",").map((tag) => tag.split(";")[0]!.trim());
  const lines = sampleStream(resolveLanguage(page.deployment.language, browser), page.deployment.siteUrl, kind);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = lines.shift();
      if (next === undefined) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
      controller.enqueue(encoder.encode(next));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
