// The embedding step of the bundle builder: BAAI/bge-small-en-v1.5 through its Xenova ONNX export,
// run with @huggingface/transformers on the CPU.
//
// The settings are the `model` block of the bundle contract (contracts/js/bundle.mjs MODEL, and
// docs/contracts/talk-bundle.md, Embedding conventions): CLS pooling, L2 normalisation, 512 tokens
// cut at the end, documents without an instruction, queries with the BGE retrieval instruction.
//
// Supply chain. The four files the pipeline reads are fetched only from
// https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/<ONNX_REVISION>/..., into a local model
// directory, and each is checked against a SHA-256 pinned below before anything is loaded; a file
// that does not match is deleted and the build fails. The library is then pointed at that directory
// with remote models and its own file cache switched off, so it can reach no other URL (its default
// loader would ask huggingface.co/.../resolve/main for some files whatever revision is requested).
// The pins were cross-checked on 2026-11-10 against what Hugging Face publishes for that revision:
// for model.onnx the LFS SHA-256 of the tree listing, for the three small files the git blob id.
// Xenova's model.onnx is also byte-identical to onnx/model.onnx of the official BAAI repository.
//
// Determinism. onnxruntime may split a matrix product differently depending on its thread count and
// the shape of the batch, which changes the order of float additions and so possibly an int8 value.
// The vectors are therefore computed on one intra-op and one inter-op thread, and one text per call,
// so a vector depends on its text only. (Vector reuse in build-bundles.mjs keeps published rows
// stable across machines in any case.)

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL, DIMS, QUERY_INSTRUCTION, BUNDLE_VERSION, QUANTIZATION, queryText } from '../../contracts/js/bundle.mjs';

export { DIMS, QUERY_INSTRUCTION };
export const MODEL_ID = MODEL.id;
export const ONNX_ID = MODEL.onnx;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLS_DIR = path.join(REPO_ROOT, 'tools', 'bundles');
export const TRANSFORMERS_VERSION = '4.3.2';
// The revision of the Xenova repository that the weights were verified against.
export const ONNX_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const MODEL_FILES = Object.freeze({
  'config.json': { bytes: 683, sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350' },
  'tokenizer.json': { bytes: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
  'tokenizer_config.json': { bytes: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
  'onnx/model.onnx': { bytes: 133093490, sha256: '828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35' },
});
export const modelUrl = (file) => `https://huggingface.co/${ONNX_ID}/resolve/${ONNX_REVISION}/${file}`;
/** Where the model files live: $CADDIE_MODEL_CACHE (relative paths resolve against the repository root), else .cache/model. */
export const defaultCacheDir = () => path.resolve(REPO_ROOT, process.env.CADDIE_MODEL_CACHE || '.cache/model');

/** Names what the vectors depend on; a reused vector is valid only under an identical identity. */
export function embeddingIdentity() {
  return {
    bundle_version: BUNDLE_VERSION,
    quantization: QUANTIZATION,
    model: MODEL.id,
    onnx: MODEL.onnx,
    revision: ONNX_REVISION,
    dtype: 'fp32',
    files: Object.fromEntries(Object.entries(MODEL_FILES).map(([f, m]) => [f, m.sha256])),
    pooling: MODEL.pooling,
    normalize: MODEL.normalize,
    max_tokens: MODEL.max_tokens,
    document_instruction: MODEL.document_instruction,
    library: `@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  };
}

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const sha256File = (file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex');

function verifyFile(file, meta) {
  if (!existsSync(file)) return 'missing';
  if (statSync(file).size !== meta.bytes) return `${statSync(file).size} bytes, expected ${meta.bytes}`;
  if (sha256File(file) !== meta.sha256) return 'sha256 mismatch';
  return null;
}

async function download(url, target) {
  const tmp = `${target}.part`;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    mkdirSync(path.dirname(target), { recursive: true });
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(tmp), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Makes sure the four pinned files are in `dir` and match their SHA-256. With noDownload set nothing
 * is downloaded and a missing or wrong file is an error. A file that is present but wrong is deleted and, unless
 * noDownload, fetched again once; a file that is still wrong fails the build.
 */
export async function ensureModelFiles(dir, { noDownload = false, log = () => {} } = {}) {
  for (const [name, meta] of Object.entries(MODEL_FILES)) {
    const file = path.join(dir, name);
    let problem = verifyFile(file, meta);
    if (problem && existsSync(file)) rmSync(file);
    if (problem && noDownload) throw new Error(`downloads are off: ${name} is not in the model directory ${dir} (${problem})`);
    if (problem) {
      log(`fetching ${name} from ${ONNX_ID}@${ONNX_REVISION.slice(0, 8)}`);
      await download(modelUrl(name), file);
      problem = verifyFile(file, meta);
      if (problem) {
        rmSync(file, { force: true });
        throw new Error(`${name} fetched from ${modelUrl(name)} failed verification against its pinned SHA-256 (${problem}) and was deleted`);
      }
    }
  }
}

async function loadTransformers() {
  const entry = path.join(TOOLS_DIR, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
  const pkgFile = path.join(TOOLS_DIR, 'node_modules', '@huggingface', 'transformers', 'package.json');
  if (!existsSync(entry) || !existsSync(pkgFile)) {
    throw new Error('The embedding library is not installed. Run: ONNXRUNTIME_NODE_INSTALL=skip npm --prefix tools/bundles ci');
  }
  const version = JSON.parse(readFileSync(pkgFile, 'utf8')).version;
  if (version !== TRANSFORMERS_VERSION) throw new Error(`tools/bundles has @huggingface/transformers ${version}, expected ${TRANSFORMERS_VERSION}. Run: npm --prefix tools/bundles ci`);
  return import(pathToFileURL(entry).href);
}

/** The contract's model block, checked against what this embedder implements. */
function assertContract() {
  const expected = { dims: 384, pooling: 'cls', normalize: true, max_tokens: 512, truncation: 'end', document_instruction: '' };
  for (const [k, v] of Object.entries(expected)) {
    if (MODEL[k] !== v) throw new Error(`The contract's MODEL.${k} is ${JSON.stringify(MODEL[k])}, but this embedder implements ${JSON.stringify(v)}.`);
  }
  if (MODEL.id !== 'BAAI/bge-small-en-v1.5' || MODEL.onnx !== 'Xenova/bge-small-en-v1.5') throw new Error('The contract names a different model than this embedder runs.');
}

/**
 * Loads the model. Options:
 *   cacheDir  where the pinned model files are kept (default defaultCacheDir())
 *   noDownload  never fetch the model; fails when a pinned file is not in cacheDir
 * Returns { embedDocuments(texts), embedQueries(texts), info }. Each embed call returns an array of
 * Float32Array(384) rows, L2-normalised, in the order of the texts.
 */
export async function createEmbedder({ cacheDir = defaultCacheDir(), noDownload = false, log = () => {} } = {}) {
  assertContract();
  const dir = path.resolve(cacheDir, ONNX_REVISION);
  await ensureModelFiles(dir, { noDownload, log });
  const { pipeline, env } = await loadTransformers();
  // Nothing may be fetched: the model is a local directory, and the library's own cache is off.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  const pipe = await pipeline('feature-extraction', dir, {
    local_files_only: true,
    dtype: 'fp32',
    device: 'cpu',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'all' },
  });
  const embed = async (texts) => {
    const rows = [];
    for (const text of texts) {
      const out = await pipe(text, { pooling: MODEL.pooling, normalize: MODEL.normalize });
      if (out.dims.length !== 2 || out.dims[1] !== DIMS) throw new Error(`unexpected embedding shape ${out.dims}`);
      rows.push(Float32Array.from(out.data));
    }
    return rows;
  };
  return {
    embedDocuments: (texts) => embed(texts),
    embedQueries: (texts) => embed(texts.map(queryText)),
    identity: embeddingIdentity(),
    info: { id: MODEL_ID, onnx: ONNX_ID, revision: ONNX_REVISION, dir },
  };
}
