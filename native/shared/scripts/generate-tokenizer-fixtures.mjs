// Generates native/shared/src/commonTest/kotlin/app/conferencecaddie/shared/embed/TokenizerFixtures.kt:
// texts with the token ids that transformers.js gives them under the pinned bge-small-en-v1.5
// tokenizer, the library and the files that embed the talks (scripts/lib/embedder.mjs). The Kotlin
// tokenizer has to give the same ids, or a query vector would not be comparable with the talk vectors.
//
// Usage, from the repository root after `ONNXRUNTIME_NODE_INSTALL=skip npm --prefix tools/bundles ci`:
//   node native/shared/scripts/generate-tokenizer-fixtures.mjs --queries <file> --bundles <dir> [--model <dir>]
//
//   --queries <file>      a JSON array of search queries, typed as people type them
//   --bundles <dir>       the bundles directory of a build-bundles.mjs output (<slug>/<hash>/bundle.json)
//   --model <dir>         the model directory, with tokenizer.json and tokenizer_config.json (default:
//                         where scripts/lib/embedder.mjs keeps the pinned files); both files are checked
//                         against the SHA-256 that embedder.mjs pins, and nothing is downloaded
//   --transformers <dir>  the @huggingface/transformers package (default: tools/bundles/node_modules)
//
// The cases are every query with the query instruction in front of it, the first ten also without it,
// hand-written edge cases (accents, scripts, emoji, whitespace and control characters, the special
// tokens typed as text, words at the 100-character limit, inputs at the 512-token limit), and about
// sixty talk texts (title, newline, abstract) from the bundles, among them the longest. The expected
// ids come from tokenizer(text, { truncation: true, max_length: 512 }), which is what the
// feature-extraction pipeline does: it cuts the finished sequence, [CLS] and [SEP] included, after
// 512 ids, so a longer text ends on a word piece and has no [SEP].
//
// The generated file is ASCII: every other character is written as a \uXXXX escape, so lone
// surrogates, BOMs and line separators survive and no editor can change a case by accident.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MODEL_FILES,
  ONNX_REVISION,
  QUERY_INSTRUCTION,
  TOOLS_DIR,
  TRANSFORMERS_VERSION,
  defaultCacheDir,
} from '../../../scripts/lib/embedder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'native/shared/src/commonTest/kotlin/app/conferencecaddie/shared/embed/TokenizerFixtures.kt');
const MAX_TOKENS = 512;
const TALKS_PER_BUNDLE = 14;
const LONGEST_TALKS = 5;
const QUERIES_WITHOUT_INSTRUCTION = 10;

function parseArgs(argv) {
  const opts = {
    model: path.join(defaultCacheDir(), ONNX_REVISION),
    transformers: path.join(TOOLS_DIR, 'node_modules', '@huggingface', 'transformers'),
    queries: null,
    bundles: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts) || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument ${argv[i]}`);
    opts[key] = path.resolve(argv[++i]);
  }
  if (!opts.queries || !opts.bundles) throw new Error('--queries and --bundles are required');
  return opts;
}

// The tokenizer files must be the pinned ones, or the fixture would describe another tokenizer.
function checkModel(dir) {
  for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`${file} is missing`);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sha !== MODEL_FILES[name].sha256) throw new Error(`${file} is not the pinned file (SHA-256 ${sha})`);
  }
}

async function loadTokenizer(opts) {
  const pkg = JSON.parse(readFileSync(path.join(opts.transformers, 'package.json'), 'utf8'));
  if (pkg.version !== TRANSFORMERS_VERSION) {
    throw new Error(`${opts.transformers} is @huggingface/transformers ${pkg.version}, expected ${TRANSFORMERS_VERSION}`);
  }
  const { AutoTokenizer, env } = await import(pathToFileURL(path.join(opts.transformers, 'dist/transformers.node.mjs')).href);
  // Only the local directory is read: no download, and no cache of the library's own.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  return { tokenizer: await AutoTokenizer.from_pretrained(opts.model, { local_files_only: true }), version: pkg.version };
}

// Hand-written cases: each line is one behaviour of the BERT normaliser, pre-tokeniser or WordPiece
// model, or of transformers.js in particular (the astral CJK and truncation cases).
const EDGE_CASES = [
  ['hello world', 'Hello, world!'],
  ['accents', 'naïve café résumé Zoë Ångström'],
  ['accents decomposed', 'cafe\u0301 nai\u0308ve a\u0300 n\u0303 c\u0327 o\u0308\u0304'],
  ['accented capitals', 'ÀÉÎÕÜ ÇÑ ŒÆ Ø Ł Đ'],
  ['vietnamese', 'Tiếng Việt có dấu'],
  ['sharp s', 'Straße groß ẞ GROSS'],
  ['turkish dotted and dotless i', 'İstanbul DİYARBAKIR ıi İ I'],
  ['greek final sigma', 'ΟΔΥΣΣΕΥΣ ΣΟΦΟΣ. σοφός Σ ΑΣ\'Α Καλημέρα κόσμε'],
  ['titlecase digraphs and letterlike', 'Ǆ ǅ ǆ \u212A \u212B Ⅻ ⅻ ① ² ½'],
  ['cyrillic', 'Привет, мир! Ёжик и йод'],
  ['arabic with harakat', 'مرحبا بالعالم مَرْحَبًا ١٢٣'],
  ['hebrew with niqqud', 'שָׁלוֹם עולם'],
  ['thai', 'สวัสดีครับ ภาษาไทย'],
  ['devanagari', 'नमस्ते दुनिया हिन्दी'],
  ['chinese', '中文分词测试，你好！'],
  ['cjk extension a and compatibility', '㐀㐁 豈更 ⺀ 〇'],
  ['astral cjk', '\u{20000} \u{20001}\u{20002} a\u{20000}b \u4E2D\u{20000}\u6587 \u{2A6A5}'],
  ['japanese', '東京でKubernetesを学ぶ ひらがな カタカナ ｶﾀｶﾅ ー'],
  ['korean', '한국어 텍스트 Kubernetes와 eBPF'],
  ['emoji', 'emoji \u{1F600} \u{1F44D}\u{1F3FD} rocket\u{1F680}launch \u2764\uFE0F \u263A\uFE0E 1\uFE0F\u20E3 #\uFE0F\u20E3'],
  ['emoji zwj sequences', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} family \u{1F3F3}\uFE0F\u200D\u{1F308} \u{1F469}\u{1F3FD}\u200D\u{1F4BB} dev'],
  ['flags', '\u{1F1EF}\u{1F1F5} \u{1F1FA}\u{1F1F8}\u{1F1E9}\u{1F1EA} \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} scotland'],
  ['mathematical and deseret letters', '𝐇𝐞𝐥𝐥𝐨 𝓦𝓸𝓻𝓵𝓭 𐐀𐐁 𐐨'],
  ['curly quotes', '‘single’ “double” „low“ «guillemets» ‹one› 「corner」'],
  ['dashes', '2020–2021 — em-dash ‒ figure ― bar −minus ‐hyphen'],
  ['ellipsis', 'wait… what... …and then'],
  ['tabs and newlines', 'a\tb\nc\r\nd\re\n\n\tf'],
  ['unicode spaces', 'a\u00A0b\u3000c\u2009d\u202Fe\u205Ff\u1680g\u2028h\u2029i\u200Aj'],
  ['zero width and format characters', 'zero\u200Bwidth\u200Djoiner\uFEFFbom\u2060wj\u00ADsoft\u200Eltr\u200Frtl\u202Aembed'],
  ['control characters', 'a\u0001b\u0007c\u001Fd\u007Fe\u0085f\u000Bg\u000Ch\u009Fi'],
  ['nul and replacement character', '\u0000null\u0000 replacement\uFFFDchar \uFFFD'],
  ['lone surrogates and private use', 'a\uD800b c\uDC00d e\uE000f \u{F0000}g'],
  ['numbers', '1,234,567.89 3.14159 10% $5.99 €12,50 1e-9 0x1F 2026-11-10 v1.2.3'],
  ['url', 'https://example.com/path/to?query=1&b=2#frag'],
  ['email', 'first.last+tag@example.co.uk'],
  ['code', 'foo_bar(x)->y; a[i] = b{c} | d ~ e ^ f `cmd` <tag/> \\path'],
  ['languages and versions', 'C++ C# F# .NET node.js Python3.12 k8s K8S kubectl k3s gRPC eBPF'],
  ['apostrophes', "don't won't it's rock'n'roll l'été O’Reilly"],
  ['mixed case', 'iPhone McDonald’s WiFi PyTorch JavaScript TypeScript'],
  ['symbols', '© ® ™ ° ± × ÷ € £ ¥ § ¶ • † ‰ ← → ★ ✓'],
  ['abbreviations', 'U.S.A. e.g. i.e. Dr. Smith vs. etc.'],
  ['social', '#hashtag @mention $var %percent &amp; *star* _under_'],
  ['fullwidth ascii', 'Ｈｅｌｌｏ，ＷＯＲＬＤ！１２３ ｋｕｂｅｒｎｅｔｅｓ'],
  ['special tokens as text', '[CLS] hello [SEP] [MASK]x[UNK] [PAD][PAD] [cls] [ MASK ] [SEP'],
  ['word of 100 characters', 'kubernetes'.repeat(10)],
  ['word of 101 characters', 'kubernetes'.repeat(10) + 's'],
  ['word of 100 characters once the accent is stripped', 'kubernetes'.repeat(9) + 'kubernete\u0301s'],
  ['long word between short words', 'before ' + 'supercalifragilisticexpialidocious'.repeat(4) + ' after'],
  ['unknown word', 'zzzzqqqxj 𓀀 ∰'],
  ['empty', ''],
  ['whitespace only', '  \t\n \u00A0\u3000 '],
  ['punctuation only', '!!!???...,,,;;;'],
  ['exactly 512 ids', 'hello '.repeat(MAX_TOKENS - 2)],
  ['513 ids cut to 512', 'hello '.repeat(MAX_TOKENS - 1)],
];

function readBundles(dir) {
  const out = [];
  for (const slug of readdirSync(dir).sort()) {
    const slugDir = path.join(dir, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    for (const hash of readdirSync(slugDir).sort()) {
      const file = path.join(slugDir, hash, 'bundle.json');
      if (existsSync(file)) out.push({ slug, bundle: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  if (out.length === 0) throw new Error(`no bundle.json under ${dir}`);
  return out;
}

// The talk cases: the longest texts by token count, then evenly spaced talks of each bundle in
// talk_id order, so a regenerated fixture picks the same talks from the same bundles.
function talkCases(bundles, countIds) {
  const talks = [];
  for (const { slug, bundle } of bundles) {
    const rows = new Set(bundle.vectors.rows);
    const own = bundle.talks
      .filter((t) => rows.has(t.talk_id))
      .sort((a, b) => (a.talk_id < b.talk_id ? -1 : a.talk_id > b.talk_id ? 1 : 0))
      .map((t) => ({ slug, id: t.talk_id, text: `${t.title}\n${t.abstract}` }));
    talks.push(own);
  }
  const chosen = new Map();
  const all = talks.flat().map((t) => ({ ...t, n: countIds(t.text) }));
  all.sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));
  for (const t of all.slice(0, LONGEST_TALKS)) chosen.set(t.text, { name: `longest talk ${t.id}`, text: t.text });
  for (const own of talks) {
    const step = Math.max(1, Math.floor(own.length / TALKS_PER_BUNDLE));
    for (let i = 0, n = 0; i < own.length && n < TALKS_PER_BUNDLE; i += step) {
      if (chosen.has(own[i].text)) continue;
      chosen.set(own[i].text, { name: `talk ${own[i].id}`, text: own[i].text });
      n++;
    }
  }
  // Talks whose text is above the limit are rare, so three of the longest abstracts in a row make
  // sure a real text is cut.
  const joined = all.slice(0, 3).map((t) => t.text).join('\n\n');
  chosen.set(joined, { name: 'three longest talks joined', text: joined });
  return [...chosen.values()];
}

// A Kotlin string literal that is plain ASCII.
function kotlinString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x24) out += '\\$';
    else if (c >= 0x20 && c < 0x7f) out += s[i];
    else out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `${out}"`;
}

const opts = parseArgs(process.argv.slice(2));
checkModel(opts.model);
const { tokenizer, version } = await loadTokenizer(opts);
const encode = (text) => tokenizer(text, { truncation: true, max_length: MAX_TOKENS, return_tensor: false }).input_ids;
// Without truncation: what the text would give, to record which cases were cut.
const encodeAll = (text) => tokenizer.encode(text);

const queries = JSON.parse(readFileSync(opts.queries, 'utf8'));
if (!Array.isArray(queries) || queries.some((q) => typeof q !== 'string')) throw new Error(`${opts.queries} is not a JSON array of strings`);

const cases = [
  ...queries.map((q, i) => ({ name: `query ${i + 1} with instruction`, text: QUERY_INSTRUCTION + q })),
  ...queries.slice(0, QUERIES_WITHOUT_INSTRUCTION).map((q, i) => ({ name: `query ${i + 1}`, text: q })),
  ...EDGE_CASES.map(([name, text]) => ({ name, text })),
  ...talkCases(readBundles(opts.bundles), (text) => encodeAll(text).length),
];

const rows = cases.map(({ name, text }) => {
  const ids = encode(text);
  const all = encodeAll(text);
  // The pipeline's truncation is a plain cut of the finished sequence; the tests rely on that.
  if (ids.length !== Math.min(all.length, MAX_TOKENS) || ids.some((id, i) => id !== all[i])) {
    throw new Error(`truncation of "${name}" is not a prefix cut`);
  }
  return { name, text, ids, untruncated: all.length };
});

const truncated = rows.filter((r) => r.untruncated > MAX_TOKENS).length;
let kt = '';
kt += '// Generated by native/shared/scripts/generate-tokenizer-fixtures.mjs. Do not edit.\n';
kt += 'package app.conferencecaddie.shared.embed\n\n';
kt += '/**\n';
kt += ` * Texts and the ids that @huggingface/transformers ${version} gives them with the tokenizer of\n`;
kt += ` * Xenova/bge-small-en-v1.5 at ${ONNX_REVISION.slice(0, 8)}, cut at ${MAX_TOKENS} as the feature-extraction pipeline\n`;
kt += ` * cuts them. ${rows.length} cases, ${truncated} of them longer than ${MAX_TOKENS} ids before the cut.\n`;
kt += ' */\n';
kt += 'internal object TokenizerFixtures {\n';
kt += '    /** [ids] is comma-separated; [untruncated] is the number of ids before the cut. */\n';
kt += '    class Case(val name: String, val text: String, val ids: String, val untruncated: Int)\n\n';
kt += '    val cases: List<Case> = listOf(\n';
for (const r of rows) {
  kt += `        Case(\n            ${kotlinString(r.name)},\n            ${kotlinString(r.text)},\n`;
  kt += `            "${r.ids.join(',')}",\n            ${r.untruncated},\n        ),\n`;
}
kt += '    )\n}\n';
// A JVM class file holds at most 65,535 bytes of modified UTF-8 in one string constant, at most three
// bytes for each UTF-16 unit.
for (const r of rows) {
  if (r.text.length * 3 > 60_000) throw new Error(`"${r.name}" is too long for one JVM string constant`);
}
writeFileSync(OUT, kt);
console.log(`${path.relative(ROOT, OUT)}: ${rows.length} cases (${queries.length} queries with the instruction, ` +
  `${Math.min(QUERIES_WITHOUT_INSTRUCTION, queries.length)} without, ${EDGE_CASES.length} edge cases, ` +
  `${rows.length - queries.length - Math.min(QUERIES_WITHOUT_INSTRUCTION, queries.length) - EDGE_CASES.length} talk texts), ` +
  `${truncated} cut at ${MAX_TOKENS}, ${kt.length} bytes`);
