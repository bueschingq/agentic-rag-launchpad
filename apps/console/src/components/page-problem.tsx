// Why a page failed, in plain words, with the browser's raw error folded away (lib/site-refusal.ts
// pageProblem). Any other reason a page was left out reads as it's stored.

import { pageProblem } from "@/lib/site-refusal.ts";

export function PageProblem({ detail }: { detail: string | null | undefined }) {
  const problem = pageProblem(detail);
  if (!problem) return null;
  return (
    <span className="step-detail">
      {problem.words}
      {problem.raw && (
        <details>
          <summary>What the browser said</summary>
          {problem.raw}
        </details>
      )}
    </span>
  );
}
