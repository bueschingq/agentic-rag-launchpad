// What a reply amounts to: answered or not, and the source links under it. The source picking
// (at most two, related to the question or the answer, in the visitor's language) lives in
// @launchpad/theme (sources.ts), so validation and the starter picker show exactly what visitors get.

export {
  brandWords,
  citedSources,
  MAX_SOURCES,
  pickSources,
  type Source,
  type SourceContext,
  type SourceFacts,
  safeHref,
  sourcesFor,
} from "@launchpad/theme";

// The text of each paragraph an answer cites, which grounding checks its figures, dates, links and
// steps against: the stream's augmented context (the paragraph as the model read it, with its
// neighbours) where it sent one, else the retrieved paragraph. Answers cite neighbours that
// retrieval never listed: on kemptechnologies.com "What are your prices?" (round 5) cited
// /pricing's 772-979 and 216-559, and its $4,500 and $5,300 stood only in 979-1322's augmented
// text.
export function citedPassages(
  resources: Record<string, unknown>,
  citations: Record<string, unknown> | undefined,
  augmented: Record<string, { text?: unknown }>,
): string[] {
  const retrieved = new Map<string, string>();
  for (const resource of Object.values(resources)) {
    const fields = ((resource as { fields?: unknown } | undefined)?.fields ?? {}) as Record<
      string,
      { paragraphs?: Record<string, { text?: unknown }> }
    >;
    for (const field of Object.values(fields))
      for (const [id, p] of Object.entries(field?.paragraphs ?? {})) if (typeof p?.text === "string") retrieved.set(id, p.text);
  }
  return Object.keys(citations ?? {}).flatMap((id) => {
    const text = augmented[id]?.text;
    const passage = typeof text === "string" ? text : retrieved.get(id);
    return passage ? [passage] : [];
  });
}

// The verdict (answered or not) is shared with validation and the worker's report roll-up:
// see verdict.ts in @launchpad/theme.
export {
  bestScore,
  MIN_RERANKER_SCORE,
  mayBeNoContext,
  NO_CONTEXT_ANSWER,
  type ReplyFacts,
  showsModelText,
  type Verdict,
  verdict,
} from "@launchpad/theme";
