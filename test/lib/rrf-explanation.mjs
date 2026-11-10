// The explanation Elasticsearch 9.5.6 gives a hit of an rrf retriever on the people index, for the
// in-memory stand-ins of test/. It has no side effects, so a test file with a stand-in of its own
// can import it without the fetch replacement of test/lib/fake-es.mjs.
//
// The shape was captured from the live cluster on 2026-11-10 with read-only `explain: true`
// searches over the sample profiles, built the way server/people.mjs builds a people query. The
// people index has nested fields (the semantic_text chunks), so the top of the explanation is not
// the rrf node: it is a "sum of:" whose two details are the rrf node, with one detail per
// retriever, and the filter that keeps nested chunk documents out of the hits
// ("FieldExistsQuery [field=_primary_term]", a field only top-level documents have), which
// Elasticsearch adds as a required clause. The top level therefore has two details whatever the
// number of retrievers. CAPTURED is one such explanation, verbatim except that the
// explanations of the retrievers' own queries, under each found leg, are cut to their first line.

const RANK_CONSTANT = 60;

/**
 * The explanation of one hit in that shape. ranks[i] is the hit's 1-based rank in retriever i, or
 * 0 when that retriever did not find it; names[i] is the retriever's _name.
 */
export function rrfExplanation(ranks, names) {
  const score = ranks.reduce((sum, r) => sum + (r > 0 ? 1 / (r + RANK_CONSTANT) : 0), 0);
  return {
    value: score,
    description: 'sum of:',
    details: [
      {
        value: score,
        description: `rrf score: [${score}] computed for initial ranks [${ranks.join(', ')}] with rankConstant: [${RANK_CONSTANT}] as sum of [1 / (rank + rankConstant)] for each query`,
        details: ranks.map((r, i) => (r > 0
          ? { value: r, description: `rrf score: [${1 / (r + RANK_CONSTANT)}], for rank [${r}] in query at index [${i}] [${names[i]}] computed as [1 / (${r} + ${RANK_CONSTANT})], for matching query with score`, details: [{ value: 1, description: 'sum of:', details: [] }] }
          : { value: 0, description: `rrf score: [0], result not found in query at index [${i}] [${names[i]}]`, details: [] })),
      },
      {
        value: 0,
        description: 'match on required clause, product of:',
        details: [
          { value: 0, description: '# clause', details: [] },
          { value: 1, description: 'FieldExistsQuery [field=_primary_term]', details: [] },
        ],
      },
    ],
  };
}

// A hit found by the second and third of three retrievers (topics-1, text-2, text-3), as the live
// cluster explained it.
export const CAPTURED = {
  value: 0.029910713,
  description: 'sum of:',
  details: [
    {
      value: 0.029910713,
      description: 'rrf score: [0.029910713] computed for initial ranks [0, 10, 4] with rankConstant: [60] as sum of [1 / (rank + rankConstant)] for each query',
      details: [
        { value: 0, description: 'rrf score: [0], result not found in query at index [0] [topics-1]', details: [] },
        { value: 10, description: 'rrf score: [0.014285714], for rank [10] in query at index [1] [text-2] computed as [1 / (10 + 60)], for matching query with score', details: [{ value: 0, description: 'sum of:', details: [] }] },
        { value: 4, description: 'rrf score: [0.015625], for rank [4] in query at index [2] [text-3] computed as [1 / (4 + 60)], for matching query with score', details: [{ value: 0, description: 'sum of:', details: [] }] },
      ],
    },
    {
      value: 0,
      description: 'match on required clause, product of:',
      details: [
        { value: 0, description: '# clause', details: [] },
        { value: 1, description: 'FieldExistsQuery [field=_primary_term]', details: [] },
      ],
    },
  ],
};
