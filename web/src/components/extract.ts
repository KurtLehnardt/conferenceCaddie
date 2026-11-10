// Reads the text of a schedule file in the browser, for the Pages build (VITE_CLIENT_EXTRACT=1),
// whose API runs on a Worker that cannot parse PDF or office files. The file never leaves the
// device: only the extracted text is sent to the import route. The two libraries are imported
// lazily, so neither is in the entry chunk and a visitor who never imports a file never loads them.

/** True when this build extracts files in the browser. A static check, so the code can be dropped. */
export const CLIENT_EXTRACT = import.meta.env.VITE_CLIENT_EXTRACT === '1';

/** The longest text the import route accepts. */
export const MAX_EXTRACTED_CHARS = 200_000;

/** Thrown with a sentence written for the person. */
export class ExtractError extends Error {}

const NO_TEXT = 'No text could be read from that file. If it is a scanned or password-protected PDF, export the schedule as text or CSV instead.';
const OLD_DOC = 'Old .doc files cannot be read here. Save it as .docx or PDF, or export the schedule as text or CSV instead.';

const extensionOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? '').toLowerCase();

/** Extensions that need extraction. Plain text formats (csv, tsv, txt, ics, json) are read as text. */
export function needsExtraction(file: File): boolean {
  return ['pdf', 'docx', 'odt', 'rtf', 'doc'].includes(extensionOf(file.name)) || file.type === 'application/pdf';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

async function unzipEntry(file: File, name: string): Promise<string> {
  // The build-time check lets the bundler drop the library, and its chunk, from builds without it.
  if (import.meta.env.VITE_CLIENT_EXTRACT !== '1') throw new ExtractError(NO_TEXT);
  const { unzipSync, strFromU8 } = await import('fflate');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(bytes, { filter: (f) => f.name === name });
  const entry = entries[name];
  if (!entry) throw new ExtractError(NO_TEXT);
  return strFromU8(entry);
}

/** Paragraph text of a .docx file: one line per paragraph, tabs and line breaks kept. */
async function readDocx(file: File): Promise<string> {
  const xml = await unzipEntry(file, 'word/document.xml');
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** Paragraph text of an .odt file: one line per paragraph or heading. */
async function readOdt(file: File): Promise<string> {
  const xml = await unzipEntry(file, 'content.xml');
  return decodeEntities(
    xml
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<text:s\b[^>]*\/>/g, ' ')
      .replace(/<\/text:(?:p|h)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

const RTF_SKIPPED = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'themedata', 'datastore', 'listtable', 'listoverridetable', 'rsidtbl', 'latentstyles', 'generator']);

/** Plain text of an .rtf file: control words are dropped, and so are groups that hold no body text. */
function readRtf(raw: string): string {
  const out: string[] = [];
  let depth = 0;
  // While this is set, everything up to the end of the group at that depth is skipped.
  let skipAt = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') {
      depth++;
      if (skipAt < 0) {
        const next = /^\\(\*|[a-z]+)/i.exec(raw.slice(i + 1, i + 24));
        if (next && (next[1] === '*' || RTF_SKIPPED.has(next[1].toLowerCase()))) skipAt = depth;
      }
    } else if (ch === '}') {
      if (depth === skipAt) skipAt = -1;
      depth--;
    } else if (skipAt >= 0) {
      continue;
    } else if (ch === '\\') {
      const rest = raw.slice(i + 1, i + 40);
      const hex = /^'([0-9a-f]{2})/i.exec(rest);
      if (hex) {
        out.push(String.fromCharCode(Number.parseInt(hex[1], 16)));
        i += 3;
        continue;
      }
      const word = /^([a-z]+)(-?\d+)? ?/i.exec(rest);
      if (!word) {
        // An escaped symbol: a backslash, an opening brace and a closing brace stand for themselves.
        if (/^[\\{}]/.test(rest)) out.push(rest[0]);
        i += 1;
        continue;
      }
      const name = word[1].toLowerCase();
      if (name === 'par' || name === 'line') out.push('\n');
      else if (name === 'tab') out.push('\t');
      else if (name === 'u' && word[2] !== undefined) {
        const n = Number(word[2]);
        out.push(String.fromCharCode(n < 0 ? n + 65536 : n));
        // The single fallback character after a \uN escape is not text.
        const after = raw[i + word[0].length + 1];
        if (after !== undefined && after !== '\\') i += 1;
      }
      i += word[0].length;
    } else if (ch !== '\r' && ch !== '\n') {
      out.push(ch);
    }
  }
  return out.join('');
}

/** Text of a PDF, one line per row of text, rebuilt from each item's vertical position. */
async function readPdf(file: File): Promise<string> {
  if (import.meta.env.VITE_CLIENT_EXTRACT !== '1') throw new ExtractError(NO_TEXT);
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer())});
  const doc = await task.promise;
  const out: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          out.push(line.trim());
          line = '';
        }
        line += item.str;
        if (item.hasEOL) {
          out.push(line.trim());
          line = '';
          lastY = null;
        } else {
          lastY = y;
        }
        // Items on one row are separate words or cells; keep them apart.
        if (line && !/\s$/.test(line)) line += ' ';
      }
      if (line.trim()) out.push(line.trim());
      out.push('');
    }
  } finally {
    await task.destroy();
  }
  return out.join('\n');
}

/**
 * The text of a PDF, .docx, .odt or .rtf file. A legacy .doc file is refused with a sentence that
 * points to another export. Throws ExtractError with a message for the person.
 */
export async function extractText(file: File): Promise<string> {
  const ext = extensionOf(file.name);
  let text: string;
  try {
    if (ext === 'doc') throw new ExtractError(OLD_DOC);
    if (ext === 'pdf' || file.type === 'application/pdf') text = await readPdf(file);
    else if (ext === 'docx') text = await readDocx(file);
    else if (ext === 'odt') text = await readOdt(file);
    else if (ext === 'rtf') text = readRtf(await file.text());
    else text = await file.text();
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(NO_TEXT);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new ExtractError(NO_TEXT);
  return text.slice(0, MAX_EXTRACTED_CHARS);
}
