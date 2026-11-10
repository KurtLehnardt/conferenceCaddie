// The embedding step of the bundle builder: BAAI/bge-small-en-v1.5 through its Xenova ONNX export,
// run with @huggingface/transformers on the CPU.
//
// The settings follow the model section of docs/contracts/talk-bundle.md: CLS pooling, L2
// normalisation, texts truncated to 512 tokens, documents embedded without an instruction and
// queries with the BGE retrieval instruction. The model files are pinned to one revision of the
// Xenova repository. Its onnx/model.onnx has the same SHA-256 as onnx/model.onnx in the official
// BAAI repository, and its tokenizer files are byte-identical to the official ones (docs/BUNDLES.md).
//
// Determinism. onnxruntime may split a matrix product differently depending on its thread count,
// and sums floats in a different order when it does, so the vectors are computed on one intra-op
// thread and one inter-op thread. Texts are also embedded one at a time: padding a text to the
// length of the longest text in its batch is masked out, but it changes the shape of the matrix
// products and so the last bits of the result, which could flip an int8 value. With one text per
// call a vector depends on that text only.

import path from 'node:path';

export const MODEL_ID = 'BAAI/bge-small-en-v1.5';
export const ONNX_ID = 'Xenova/bge-small-en-v1.5';
// The revision of the Xenova repository that the weights were verified against.
export const ONNX_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
export const DIMS = 384;

/**
 * Loads the model. Options:
 *   cacheDir  where the model files are cached (default: $TRANSFORMERS_CACHE, else .cache/transformers)
 *   offline   never touch the network; fails when the model is not in the cache
 * Returns { embedDocuments(texts), embedQueries(texts), info }. Each embed call returns an array of
 * Float32Array(384) rows, L2-normalised, in the order of the texts.
 */
export async function createEmbedder({ cacheDir = process.env.TRANSFORMERS_CACHE || '.cache/transformers', offline = false, log = () => {} } = {}) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.resolve(cacheDir);
  let pipe;
  try {
    pipe = await pipeline('feature-extraction', ONNX_ID, {
      revision: ONNX_REVISION,
      local_files_only: offline,
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'all' },
      progress_callback: (p) => { if (p.status === 'download') log(`loading ${p.file}`); },
    });
  } catch (err) {
    throw new Error(offline ? `--offline: ${ONNX_ID} is not in the cache at ${env.cacheDir} (${err.message})` : `Could not load ${ONNX_ID}: ${err.message}`);
  }
  const embed = async (texts) => {
    const rows = [];
    for (const text of texts) {
      const out = await pipe(text, { pooling: 'cls', normalize: true });
      if (out.dims.length !== 2 || out.dims[1] !== DIMS) throw new Error(`unexpected embedding shape ${out.dims}`);
      rows.push(Float32Array.from(out.data));
    }
    return rows;
  };
  return {
    embedDocuments: (texts) => embed(texts),
    embedQueries: (texts) => embed(texts.map((q) => QUERY_INSTRUCTION + q)),
    info: { id: MODEL_ID, onnx: ONNX_ID, revision: ONNX_REVISION, cacheDir: env.cacheDir },
  };
}
