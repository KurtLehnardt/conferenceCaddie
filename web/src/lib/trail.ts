import type { Route } from './route';

// The browser never says what the history entry behind the current one is, and the in-app Back
// button needs to know: it may call history.back() only when that entry is the screen it leads to,
// otherwise it would land somewhere else. So the app keeps its own record. Every history entry is
// numbered in history.state, which survives a reload, and the route seen at each number is kept in
// memory. After a reload the earlier entries are unknown, and Back then links instead of popping.

const KEY = 'caddieEntry';

interface Entry {
  route: Route;
  href: string;
}

const entries = new Map<number, Entry>();
let current = -1;

function numberOf(state: unknown): number | null {
  const n = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof n === 'number' ? n : null;
}

export interface Visit {
  /** True when this is the same navigation as the one already handled. */
  duplicate: boolean;
  /** The route of the history entry behind this one, or null when it is not known. */
  previous: Route | null;
}

/**
 * Records that the app is now showing `route` at the current history entry. Call it from every
 * route-change event. Chrome fires both popstate and hashchange for one hash navigation, so the
 * second call for the same entry comes back as a duplicate and the caller should ignore it.
 */
export function visit(route: Route): Visit {
  const href = location.pathname + location.search + location.hash;
  let index = numberOf(history.state);
  if (index === null) {
    // A new entry. The browser drops every entry ahead of the one it was pushed from.
    index = current + 1;
    for (const key of [...entries.keys()]) if (key >= index) entries.delete(key);
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState({ ...state, [KEY]: index }, '');
  } else if (index === current && entries.get(index)?.href === href) {
    return { duplicate: true, previous: entries.get(index - 1)?.route ?? null };
  }
  current = index;
  entries.set(index, { route, href });
  return { duplicate: false, previous: entries.get(index - 1)?.route ?? null };
}
