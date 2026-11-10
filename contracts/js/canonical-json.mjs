// Canonical JSON for content hashing, as used by the talk bundle (docs/contracts/talk-bundle.md).
//
// The output is the JSON Canonicalization Scheme (RFC 8785) restricted to the values a bundle may
// hold: objects, arrays, strings, booleans, null and safe integers. Object keys are sorted by
// UTF-16 code units (JavaScript's default string order, which is what RFC 8785 specifies), there is
// no whitespace, and strings are escaped exactly as JSON.stringify escapes them, which matches RFC
// 8785. Non-integer numbers are refused rather than serialised, because the shortest round-trip
// form of a binary float is the one part of RFC 8785 that differs between JSON libraries; bundle
// files therefore hold no floats.

export function canonicalJson(value) {
  return serialise(value, '');
}

function serialise(value, path) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path || '(root)'}: canonical JSON holds only safe integers, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => serialise(v, `${path}/${i}`)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialise(value[k], `${path}/${k}`)}`).join(',')}}`;
  }
  throw new TypeError(`${path || '(root)'}: ${typeof value} cannot be serialised`);
}
