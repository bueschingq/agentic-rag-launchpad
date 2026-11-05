// Validation that runs by itself, every minute (each run marked auto, for the alerts job and
// Fleet): a run with under half the pages answerable runs again once half are; a run that asked
// while the first sync was still loading pages runs again once the sync has finished (so nobody
// watches the sync to press Run again); and a question waiting on pages a person added for it
// ("Add these pages") is asked again once they're answerable. After each, a live starter with no
// answer is asked once more and, if it fails again, taken off the chat (audited as
// deployment.starters.removed; only a person puts a button back). The work is the console's
// (revalidate() in its lib/validation.ts), so a run here asks and judges exactly as a run from the
// panel does, and sets the sign-off's heldAt when it leaves nothing open.

import { revalidate } from "../../../console/src/lib/validation.ts";
import type { JobContext } from "../context.ts";

export async function revalidateAfterSync(ctx: JobContext, now = new Date()): Promise<void> {
  for (const line of await revalidate(now)) ctx.log(`validation: ${line}`);
}
