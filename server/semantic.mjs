// Whether Elasticsearch can build query embeddings right now.
//
// Every semantic query (a knn with query_vector_builder.text_embedding) asks Elasticsearch to embed
// the text with the semantic_text field's inference endpoint. When that endpoint is over its trial
// quota, unallocated or down, every such query fails while plain keyword queries keep working.
// Rather than answer "unavailable", the search, recommendation and people routes fall back to
// keyword matching for a minute, tell the client they did (`degraded: { semantic: true }`), and
// try the semantic query again after that. Nothing here is stored; one line is logged per pause.

export const SEMANTIC_PAUSE_MS = 60_000;

let pausedUntil = 0;

/** True when semantic queries should be sent. */
export function semanticAvailable() {
  return Date.now() >= pausedUntil;
}

/**
 * Pauses semantic queries after one failed. `err` is the UpstreamError from the transport; only
 * its message (an Elasticsearch error type or a status) reaches the log, never any query text.
 */
export function pauseSemantic(err) {
  const first = pausedUntil <= Date.now();
  pausedUntil = Date.now() + SEMANTIC_PAUSE_MS;
  if (first) console.error(`Semantic matching paused for ${SEMANTIC_PAUSE_MS / 1000} s; keyword matching only: ${err?.message ?? 'error'}`);
}
