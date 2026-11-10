// Whether Elasticsearch can build query embeddings right now.
//
// Every semantic query (a knn with query_vector_builder.text_embedding) asks Elasticsearch to embed
// the text with the semantic_text field's inference endpoint. When that endpoint is over its trial
// quota, unallocated or down, every such query fails while plain keyword queries keep working.
// Rather than answer "unavailable", the search, recommendation and people routes fall back to
// keyword matching for a minute, tell the client they did (`degraded: { semantic: true }`), and
// try the semantic query again after that. Nothing here is stored; one line is logged per pause.
//
// Only an inference failure pauses (isInferenceFailure): a shard hiccup, a timeout or a rejected
// request is not the model's fault, so it fails that one request as before and leaves semantic
// matching, and the text of profile saves, alone.

export const SEMANTIC_PAUSE_MS = 60_000;

let pausedUntil = 0;

/** True when semantic queries should be sent. */
export function semanticAvailable() {
  return Date.now() >= pausedUntil;
}

/**
 * Pauses semantic queries after one failed. `err` is the UpstreamError from the transport; only
 * its message (a status) and its Elasticsearch error type reach the log, never a reason or any
 * query text.
 */
export function pauseSemantic(err) {
  const first = pausedUntil <= Date.now();
  pausedUntil = Date.now() + SEMANTIC_PAUSE_MS;
  const type = Array.isArray(err?.types) && err.types.length ? ` (${err.types[0]})` : '';
  if (first) console.error(`Semantic matching paused for ${SEMANTIC_PAUSE_MS / 1000} s; keyword matching only: ${err?.message ?? 'error'}${type}`);
}

// Error types Elasticsearch reports when the inference endpoint behind a semantic_text field fails:
// status_exception (ElasticsearchStatusException, what the inference service wraps an upstream
// 4xx/5xx or a trial limit in), inference_exception, and anything naming inference or a model
// deployment.
const INFERENCE_TYPE_RE = /^(?:status_exception|inference_exception|model_deployment_[a-z_]*|[a-z_]*inference[a-z_]*)$/;
// A reason that names inference or a trial limit. Matched where the error object is in hand; the
// reason itself is never kept or logged, only this yes or no.
const INFERENCE_REASON_RE = /\binference\b|\btrial\b/i;
// Types whose reason may quote a document's own text (a mapping error) or that are plainly not the
// model's fault, so a matching word in their reason means nothing.
const NOT_INFERENCE_TYPES = new Set(['version_conflict_engine_exception', 'mapper_parsing_exception', 'document_parsing_exception', 'strict_dynamic_mapping_exception', 'parsing_exception', 'x_content_parse_exception']);

/**
 * What the transports keep of an Elasticsearch error object (`error` of an error response, a bulk
 * item or an msearch item): the type names of it, its caused_by chain, its root causes and failed
 * shards, and whether any reason names inference or a trial limit. Returns { types, inferenceReason }.
 */
export function esErrorInfo(error) {
  const types = new Set();
  let inferenceReason = false;
  const visit = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > 6) return;
    if (typeof e.type === 'string') types.add(e.type);
    if (typeof e.reason === 'string' && INFERENCE_REASON_RE.test(e.reason)) inferenceReason = true;
    visit(e.caused_by, depth + 1);
    if (Array.isArray(e.root_cause)) for (const r of e.root_cause) visit(r, depth + 1);
    if (Array.isArray(e.failed_shards)) for (const f of e.failed_shards) visit(f?.reason, depth + 1);
  };
  visit(error, 0);
  return { types: [...types], inferenceReason };
}

/**
 * True when `err` (an UpstreamError carrying `types` and `inferenceReason` from esErrorInfo, or
 * the same shape built from a bulk item) says the inference endpoint failed. Only then do callers
 * pause semantic queries and retry keyword-only; anything else propagates.
 */
export function isInferenceFailure(err) {
  const types = Array.isArray(err?.types) ? err.types : [];
  if (types.some((t) => INFERENCE_TYPE_RE.test(t))) return true;
  return err?.inferenceReason === true && !types.some((t) => NOT_INFERENCE_TYPES.has(t));
}
