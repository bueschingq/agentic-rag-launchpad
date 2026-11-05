// Runs validation for the panel and streams its progress, so the partner sees answers come in
// instead of a fixed estimate. NDJSON, one line per event: { done, total } after each answer,
// then { finished: true, passed } or { error }. The run saves its result even if the panel goes
// away part-way. Same-origin JSON only: the console's own panel, never another site's form.
// Questions the last run had a problem with and the list leaves out come with a reason each, and
// the person removing them (a typed name in setup mode).

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth.ts";
import { loadDeployment } from "@/lib/provisioning.ts";
import { confirmationBy, type DraftQuestion, isQuestionIntent, MAX_QUESTIONS, runValidation } from "@/lib/validation.ts";

type Params = { params: Promise<{ id: string; deploymentId: string }> };

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export async function POST(request: Request, { params }: Params) {
  const { id, deploymentId } = await params;
  const site = request.headers.get("sec-fetch-site");
  if ((site && site !== "same-origin") || !request.headers.get("content-type")?.startsWith("application/json")) {
    return json({ error: "Run validation from the console." }, 403);
  }
  if (!(await loadDeployment(id, deploymentId))) return json({ error: "This deployment no longer exists." }, 404);
  const body = (await request.json().catch(() => undefined)) as
    | { draft?: unknown; note?: unknown; reasons?: unknown; typedName?: unknown }
    | undefined;
  const draft: DraftQuestion[] = (Array.isArray(body?.draft) ? body.draft : [])
    .slice(0, MAX_QUESTIONS * 2)
    .map((q: { question?: unknown; own?: unknown; intent?: unknown; wording?: unknown }) => ({
      question: text(q?.question, 300),
      own: q?.own === true,
      // One of the intent questions: it needs a decision when it gets no answer.
      ...(q?.own !== true && isQuestionIntent(q?.intent) && { intent: q.intent }),
      ...(q?.own !== true && isQuestionIntent(q?.intent) && (q?.wording === "generic" || q?.wording === "named") && { wording: q.wording }),
    }));
  const note = text(body?.note, 200) || undefined;
  const reasons = (Array.isArray(body?.reasons) ? body.reasons : [])
    .slice(0, MAX_QUESTIONS * 2)
    .map((r: { question?: unknown; reason?: unknown }) => ({ question: text(r?.question, 300), reason: text(r?.reason, 300) }));
  const user = await currentUser();
  // Who ran it: needed to remove a question with a problem; otherwise recorded when known (in setup
  // mode the typed name, "(not verified)" on the record).
  const typed = text(body?.typedName, 80);
  const confirmed = reasons.length || typed || !user.setupMode ? confirmationBy(user, typed) : undefined;
  if (confirmed && "error" in confirmed && reasons.length) return json({ error: confirmed.error }, 400);
  const by = confirmed && !("error" in confirmed) ? confirmed : undefined;
  if (!draft.length) return json({ error: "Generate questions and add your own first." }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: object) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The panel went away: the run carries on and saves.
        }
      };
      const result = await runValidation(deploymentId, user.id, draft, {
        generationNote: note,
        onProgress: (done, total) => send({ done, total }),
        reasons,
        ...(by && { who: by }),
      }).catch((err: unknown) => ({ error: `Validation stopped: ${err instanceof Error ? err.message : err}` }));
      try {
        revalidatePath(`/customers/${id}/deployments/${deploymentId}`);
      } catch {
        // The panel refreshes the page itself when the run ends.
      }
      send("error" in result ? { error: result.error } : { finished: true, passed: result.validation.passed });
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
