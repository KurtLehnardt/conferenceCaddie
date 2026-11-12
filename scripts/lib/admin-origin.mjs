// The origin rules of the X-Caddie-Admin v2 signature (scripts/lib/admin-sign.mjs, design in
// DECISIONS.md "Admin signature v2"), in a module with no imports at all: no node: module, no
// Buffer, no process. The Worker can import it as it is, so the client, the Node verifier and the
// Worker read an origin, ADMIN_ORIGIN and ADMIN_SIG_MIN with the same code. admin-sign.mjs
// re-exports everything here. test/fixtures/admin-sign.v2.json holds the vectors ("origin" cases
// and worker_config_cases), and test/admin-sign-v2.test.mjs fails if this file ever imports
// anything.

// A request the signer refuses before anything is sent: the caller's mistake, exit code 2 in the CLI.
export class UsageError extends Error {
  constructor(message, code = 'usage') {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.exitCode = 2;
  }
}

// An origin value, after trimming, must pass all four checks, then parse as a bare http: or https:
// URL. ORIGIN_ALLOW_RE alone implies the other three; they stay as named refusals.
//   ORIGIN_CHARS_RE      printable ASCII only: no tab or newline inside, no full-width or other
//                        non-ASCII character, which the URL parser would strip or map silently.
//   ORIGIN_PREFIX_RE     a literal "http://" or "https://", in any case: the parser also accepts
//                        "https:host", "https:\\host" and "https:///host".
//   ORIGIN_FORBIDDEN_RE  no "@" (userinfo, even an empty one), no backslash (read as "/"), no "%"
//                        (the parser decodes a percent-encoded host and then maps it, so
//                        "%E3%80%82" becomes a dot and "%C3%BC" becomes punycode) and no "," (the
//                        ADMIN_ORIGIN separator). No legitimate origin holds any of them.
//   ORIGIN_ALLOW_RE      the whole value: scheme, "//", a host of letters, digits, "." and "-" or
//                        a bracketed IPv6 address, an optional port, an optional final "/".
export const ORIGIN_CHARS_RE = /^[\x21-\x7e]+$/;
export const ORIGIN_PREFIX_RE = /^https?:\/\//i;
export const ORIGIN_FORBIDDEN_RE = /[@\\%,]/;
export const ORIGIN_ALLOW_RE = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]*)?\/?$/i;
const ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);
// ORIGIN_ALLOW_RE with the host (group 1) and the port (group 2, possibly empty) captured, so the
// host and port the URL parser returns can be compared with the ones typed.
const ORIGIN_PARTS_RE = /^https?:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]*))?\/?$/i;
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

// The origin a v2 signature binds, read strictly from a string: surrounding whitespace is trimmed
// (String.prototype.trim), the four checks above run, and the rest must parse as an http: or
// https: URL with path "/" or none and no query, fragment, user name or password. The parser must
// not have turned the host into another one: its host must be the typed host in lower case, and
// its port the typed port with the scheme's default port (or an empty port) dropped. That refuses
// the numeric IPv4 forms the parser rewrites (2130706433, 0x7f.1, 0177.0.0.1, 127.000.0.1, 127.1,
// a dotted quad with a trailing dot), an IPv6 address not in its canonical compressed form, and a
// port with a leading zero; a canonical dotted quad such as 127.0.0.1 and [::1] stay. The result
// is new URL(value).origin: lowercase scheme and host, the default port dropped. Returns null for
// anything else, including a URL object and a request URL with a path (a Worker that falls back to
// its request's own origin takes new URL(request.url).origin, not this). An internationalised host
// is accepted in its punycode (xn--) form only; "https://caddie.example." keeps its trailing dot
// and is another origin.
export function canonicalOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!ORIGIN_CHARS_RE.test(text) || !ORIGIN_PREFIX_RE.test(text) || ORIGIN_FORBIDDEN_RE.test(text) || !ORIGIN_ALLOW_RE.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!ORIGIN_PROTOCOLS.has(u.protocol)) return null;
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return null;
  const [, typedHost, typedPort = ''] = ORIGIN_PARTS_RE.exec(text);
  if (u.hostname !== typedHost.toLowerCase()) return null;
  if (u.port !== (typedPort === DEFAULT_PORTS[u.protocol] ? '' : typedPort)) return null;
  return u.origin;
}

// The Worker's ADMIN_ORIGIN, as the Worker reads it (the fixture's worker_admin_origin):
//   { mode: 'fallback', origins: [] }  unset, or empty after trimming: the expected origin is then
//                                      [new URL(request.url).origin], taken as it is;
//   { mode: 'list', origins }          a comma-separated list, each entry read with
//                                      canonicalOrigin, duplicates dropped, in first-seen order;
//   { mode: 'invalid', origins: [] }   any refused entry (an empty one from a stray comma
//                                      included), or a value that is not a string: every admin
//                                      request answers 404, v1 included, with no failed-auth charge.
export function parseAdminOrigin(raw) {
  if (raw === undefined || raw === null) return { mode: 'fallback', origins: [] };
  if (typeof raw !== 'string') return { mode: 'invalid', origins: [] };
  if (raw.trim() === '') return { mode: 'fallback', origins: [] };
  const origins = raw.split(',').map(canonicalOrigin);
  if (origins.includes(null)) return { mode: 'invalid', origins: [] };
  return { mode: 'list', origins: [...new Set(origins)] };
}

// The Worker's ADMIN_SIG_MIN, as the Worker reads it (the fixture's worker_admin_sig_min): unset
// (undefined) allows [2], exactly "1" allows [1, 2] (the rollback of step d of the migration),
// exactly "2" allows [2], and anything else, the empty string, surrounding whitespace and "02"
// included, is invalid configuration (null: every admin request answers 404). The match is exact
// on purpose: a loose reading of a value meant as "2" would fail open and accept v1 again. The
// Worker itself never passes undefined: it substitutes its source default, WORKER_DEFAULT_SIG_MIN
// in worker/src/lib/admin-auth.js ("2" since step d), for an absent setting, and
// worker/test/admin-auth-v2.test.mjs checks that both readings of an absent setting agree.
export function parseAdminSigMin(raw) {
  if (raw === undefined) return [2];
  if (raw === '1') return [1, 2];
  if (raw === '2') return [2];
  return null;
}

// The client's override of the version it signs, from step c of the migration until step e, which
// removes it once the first weekly CI ingest under step d has passed: CADDIE_ADMIN_SIG_VERSION
// unset or empty means 2 (GitHub Actions passes an undefined repository variable as the empty
// string), exactly "1" or "2" means that version, and anything else is a UsageError ("version",
// exit 2). Since step d the Worker refuses v1 unless its ADMIN_SIG_MIN is "1" (the rollback, which
// belongs in [vars] of worker/wrangler.toml, committed and deployed, never a secret), so "1" is
// useful only together with that rollback. `env` is passed in (process.env in Node), so this module
// needs no process.
export const SIG_VERSION_ENV = 'CADDIE_ADMIN_SIG_VERSION';

export function signVersionFromEnv(env) {
  if (env === null || typeof env !== 'object') throw new TypeError('signVersionFromEnv needs the environment object as its argument.');
  const raw = env[SIG_VERSION_ENV];
  if (raw === undefined || raw === '') return 2;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  throw new UsageError(`${SIG_VERSION_ENV} must be exactly "1" or "2" when it is set.`, 'version');
}
