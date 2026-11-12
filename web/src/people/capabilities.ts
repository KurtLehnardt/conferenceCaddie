// What the backend offers, from GET /api/capabilities (docs/contracts/capabilities.md). The web app
// reads one flag from it: people.presence_keep_until, which says that PUT /api/presence takes
// until: 'keep'. A backend without the document (the mock build, an older server) or one whose
// answer cannot be read offers nothing, which keeps today's behaviour. A good answer is kept for
// the page's lifetime; after a failure the document is asked for again, at most once a minute.
import { apiFetch } from '../lib/apiBase';

const RETRY_MS = 60_000;
const TIMEOUT_MS = 5_000;

let answer: Promise<boolean> | null = null;
let failedAt = -Infinity;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether the document offers until: 'keep', by the contract's consumer rules: only the literal
 * true counts, and only together with the people features and presence it depends on.
 */
export function offersKeepUntil(doc: unknown): boolean {
  const people = isObject(doc) && isObject(doc.people) ? doc.people : null;
  return people !== null && people.enabled === true && people.reports === true && people.presence === true && people.presence_keep_until === true;
}

async function read(): Promise<boolean> {
  const ctrl = new AbortController();
  const limit = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await apiFetch('/api/capabilities', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return offersKeepUntil(await res.json());
  } finally {
    clearTimeout(limit);
  }
}

/** True when this backend takes until: 'keep' on PUT /api/presence. Never rejects. */
export function keepUntilOffered(): Promise<boolean> {
  if (answer) return answer;
  if (Date.now() - failedAt < RETRY_MS) return Promise.resolve(false);
  answer = read().catch(() => {
    failedAt = Date.now();
    answer = null;
    return false;
  });
  return answer;
}

/** Forgets what was read, for tests. */
export function resetCapabilities(): void {
  answer = null;
  failedAt = -Infinity;
}
