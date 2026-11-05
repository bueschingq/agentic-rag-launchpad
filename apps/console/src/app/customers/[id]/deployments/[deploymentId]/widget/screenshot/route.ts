// The latest scan's screenshot of the customer's site, behind the preview. The URL carries
// the scan's id, so a rescan is a new address and the image can be cached.

import { loadScreenshot } from "@/lib/widget.ts";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id, deploymentId } = await params;
  const image = await loadScreenshot(id, deploymentId);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}
