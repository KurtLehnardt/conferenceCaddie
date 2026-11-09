// Renders highlight evidence without ever parsing it as HTML. The server sends
// HTML-escaped text with only <mark> and </mark> tags; this splits on those tags,
// decodes entities in the text pieces, and builds text nodes and <mark> elements.

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body] ?? whole;
  });
}

export function Evidence({ text }: { text: string }) {
  const pieces = text.split(/(<mark>|<\/mark>)/);
  const out = [];
  let marked = false;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p === '<mark>') {
      marked = true;
      continue;
    }
    if (p === '</mark>') {
      marked = false;
      continue;
    }
    if (!p) continue;
    const decoded = decodeEntities(p);
    out.push(marked ? <mark key={i}>{decoded}</mark> : decoded);
  }
  return <>{out}</>;
}
