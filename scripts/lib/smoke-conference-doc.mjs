// The conference document as the smoke sends it to PUT /admin/conferences: the committed
// data/<slug>/conference.json without the operator-only keys, so no automated path can ever send them
// (the same two keys worker/ingest/push-ingest.mjs strips).
export const OPERATOR_ONLY_KEYS = ['unretire', 'expect_status'];

export function conferenceForWorker(doc) {
  const out = { ...doc };
  for (const k of OPERATOR_ONLY_KEYS) delete out[k];
  return out;
}
