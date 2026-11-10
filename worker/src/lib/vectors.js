// Vector helpers. Vectors are normalised Float32Array values stored as little-endian float32
// BLOBs, so cosine similarity is a dot product.

// The bytes of a vector as a fresh ArrayBuffer, for a BLOB column. Null stays null.
export function toBlob(f32) {
  if (!f32) return null;
  const v = f32 instanceof Float32Array ? f32 : Float32Array.from(f32);
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
}

// A Float32Array view over a BLOB read from SQLite, without copying when it is aligned.
export function fromBlob(buf) {
  if (!buf) return null;
  if (buf instanceof ArrayBuffer) return buf.byteLength % 4 === 0 ? new Float32Array(buf) : null;
  if (ArrayBuffer.isView(buf)) {
    if (buf.byteLength % 4 !== 0) return null;
    if (buf.byteOffset % 4 === 0) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return null;
}

// The vector scaled to length 1, in place when it is a Float32Array. A zero vector stays zero.
export function normalize(f32) {
  const v = f32 instanceof Float32Array ? f32 : Float32Array.from(f32);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  if (s > 0) {
    const inv = 1 / Math.sqrt(s);
    for (let i = 0; i < v.length; i++) v[i] *= inv;
  }
  return v;
}

export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// The k items most similar to query, best first, as [{ item, score }]. vecOf(item) returns a
// vector, an array of vectors (the best one counts), or null to skip the item.
export function topK(query, items, k, vecOf) {
  if (!query || k <= 0) return [];
  const scored = [];
  for (const item of items) {
    const v = vecOf(item);
    if (!v) continue;
    let score = -Infinity;
    if (Array.isArray(v)) {
      for (const x of v) if (x) score = Math.max(score, dot(query, x));
    } else {
      score = dot(query, v);
    }
    if (score > -Infinity) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length > k ? scored.slice(0, k) : scored;
}

// Reciprocal rank fusion. lists is an array of id arrays, each in rank order; each list counts up
// to window entries. Returns [{ id, score, legs }] best first, where legs holds the indexes of
// the lists that contained the id. Ties keep the order in which ids were first seen.
export function rrf(lists, { k = 60, window = Infinity } = {}) {
  const acc = new Map();
  lists.forEach((list, leg) => {
    const n = Math.min(list.length, window);
    for (let i = 0; i < n; i++) {
      const id = list[i];
      let e = acc.get(id);
      if (!e) {
        e = { id, score: 0, legs: [] };
        acc.set(id, e);
      }
      if (e.legs.includes(leg)) continue;
      e.score += 1 / (k + i + 1);
      e.legs.push(leg);
    }
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
