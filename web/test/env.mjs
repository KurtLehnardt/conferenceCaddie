// Browser stand-ins for the people modules under node --test: window with a manual timer queue,
// document, an in-memory localStorage, navigator, and a fetch that records every request and
// answers from a handler the test sets. Nothing here reaches the network.
//
// Import this module before any module from web/src.

/** Timers set through window.setTimeout; they run only when a test calls runTimers(). */
export const timers = new Map();
let nextTimer = 0;

const win = new EventTarget();
win.setTimeout = (fn) => {
  const id = ++nextTimer;
  timers.set(id, fn);
  return id;
};
win.clearTimeout = (id) => {
  timers.delete(id);
};
globalThis.window = win;

const doc = new EventTarget();
doc.visibilityState = 'visible';
globalThis.document = doc;

class MemoryStorage {
  #items = new Map();
  get length() {
    return this.#items.size;
  }
  key(i) {
    return [...this.#items.keys()][i] ?? null;
  }
  getItem(key) {
    return this.#items.has(key) ? this.#items.get(key) : null;
  }
  setItem(key, value) {
    this.#items.set(key, String(value));
  }
  removeItem(key) {
    this.#items.delete(key);
  }
  clear() {
    this.#items.clear();
  }
}
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'node' }, configurable: true, writable: true });

/** Every request the modules made, in order: { method, path, body }. */
export const calls = [];
let handler = () => json(200, { ok: true });

/** Sets how the fake server answers. The function gets the recorded call and returns a Response. */
export function onFetch(fn) {
  handler = fn;
}

globalThis.fetch = async (path, init = {}) => {
  const call = { method: init.method ?? 'GET', path: String(path), body: init.body ? JSON.parse(init.body) : null };
  calls.push(call);
  return handler(call);
};

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The answer to a profile PUT: whatever the request asked for. */
export function putAnswer(call) {
  return json(200, { ok: true, open_to_meet: call.body.open_to_meet, shared_talk_ids: call.body.shared_talk_ids, hidden_for_owner: false });
}

/** Runs every timer that is due, as the browser would once the debounce has passed. */
export async function runTimers() {
  const due = [...timers.values()];
  timers.clear();
  await Promise.all(due.map((fn) => fn()));
}

/** Lets pending promise callbacks and I/O run. */
export function flush() {
  return new Promise((r) => setImmediate(r));
}

/** A promise with its resolve function, for answers the test releases later. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** The method and path of each request, for compact assertions. */
export function requests() {
  return calls.map((c) => `${c.method} ${c.path.split('?')[0]}`);
}

export function resetFake() {
  calls.length = 0;
  timers.clear();
  handler = () => json(200, { ok: true });
  localStorage.clear();
  navigator.onLine = true;
  doc.visibilityState = 'visible';
}
