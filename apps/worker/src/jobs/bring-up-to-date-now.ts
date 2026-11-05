// Bring up to date overnight, forced now (the review environment: proposal round 6, item 5):
//
//   node --env-file=.env apps/worker/src/jobs/bring-up-to-date-now.ts [deploymentId …] [--wait]
//
// One run of the job outside the night's hours, for every deployment behind or only those named.
// A deployment behind on its pages is queued to be read again by the first run; the worker's
// content sync (running as usual) reads them, and a later run re-checks it and applies or holds.
// With --wait, runs every minute until nothing is left to do, or 35 minutes (a re-read lists its
// unfinished pages after 30). Writes what each run did to the console.

import { createContext } from "../context.ts";
import { forceUpToDate } from "./rules-rollout.ts";

const args = process.argv.slice(2);
const wait = args.includes("--wait");
const only = args.filter((a) => /^[0-9a-f-]{36}$/.test(a));
const ctx = createContext();
const deadline = Date.now() + 35 * 60_000;
try {
  for (;;) {
    const done = await forceUpToDate(ctx, only.length ? only : undefined);
    const waiting = done.filter((line) => line.includes("still reading") || line.includes("being read again"));
    if (!wait || !done.length || (!waiting.length && done.every((l) => !l.includes("tried again later"))) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
} finally {
  await ctx.close();
}
process.exit(0);
