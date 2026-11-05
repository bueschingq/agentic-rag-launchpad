// The Agentic RAG agents pilot: agents only apply to pages as they're processed, so when they're
// turned on for a deployment that already has pages, those pages are sent through processing
// again, one batch a minute (50 pages), until the KB's resource list is done. A batch where
// nothing could be sent holds its place and tries again; ten in a row stop it, with the error
// shown on the deployment page. The work is the console's (reprocessPending() in its
// lib/augmentation.ts), next to where the agents are created and their progress is read.

import { reprocessPending } from "../../../console/src/lib/augmentation.ts";
import type { JobContext } from "../context.ts";

export async function reprocessForAgents(ctx: JobContext, now = new Date()): Promise<void> {
  for (const line of await reprocessPending(now)) ctx.log(`augment: ${line}`);
}
