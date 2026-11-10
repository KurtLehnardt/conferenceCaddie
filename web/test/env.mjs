// Browser stand-ins for the people modules under node --test: window with a manual timer queue,
// document, an in-memory localStorage, navigator (with Web Locks only when a test installs them),
// and a fetch that records every request and answers from a handler the test sets. Nothing here
// reaches the network.
//
// Import this module before any module from web/src.

/** Timers set through window.setTimeout, as { fn, ms }; they run only when a test runs them. */
export const timers = new Map();
let nextTimer = 0;

/** The profile edit debounce in sync.ts; every other window timer is a delete retry. */
export const DEBOUNCE_MS = 1000;

const win = new EventTarget();
win.setTimeout = (fn, ms = 0) => {
  const id = ++nextTimer;
  timers.set(id, { fn, ms });
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
  const answer = Promise.resolve(handler(call));
  const signal = init.signal;
  if (!signal) return answer;
  // An aborted request fails at once, as the browser's fetch does, even if the fake never answers.
  return Promise.race([
    answer,
    new Promise((_, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort);
    }),
  ]);
};

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** The answer to a profile PUT: whatever the request asked for. */
export function putAnswer(call) {
  return json(200, { ok: true, open_to_meet: call.body.open_to_meet, shared_talk_ids: call.body.shared_talk_ids, hidden_for_owner: false });
}

/** Runs the waiting profile-edit debounce, as the browser would once a second has passed. */
export async function runTimers() {
  const due = [...timers].filter(([, t]) => t.ms === DEBOUNCE_MS);
  for (const [id] of due) timers.delete(id);
  await Promise.all(due.map(([, t]) => t.fn()));
}

/** Runs the waiting delete-retry timer, as the browser would once its wait is over. */
export function runRetryTimer() {
  const due = [...timers].filter(([, t]) => t.ms !== DEBOUNCE_MS);
  for (const [id] of due) timers.delete(id);
  for (const [, t] of due) t.fn();
}

/** The number of profile edits waiting for their debounce. */
export function debounces() {
  return [...timers.values()].filter((t) => t.ms === DEBOUNCE_MS).length;
}

/** Lets pending promise callbacks and I/O run. */
export function flush() {
  return new Promise((r) => setImmediate(r));
}

/** Lets a chain of answered requests run to its end. */
export async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}

/**
 * Web Locks as one browser shares them between its tabs: one holder per name at a time, waiters in
 * order, `ifAvailable` and `signal` honoured. `hold(name)` takes a lock as another tab would and
 * returns the function that lets it go.
 */
export function installLocks() {
  const state = new Map();
  const of = (name) => state.get(name) ?? (state.set(name, { busy: false, waiters: [] }), state.get(name));
  const locks = {
    request(name, options, fn) {
      if (typeof options === 'function') [fn, options] = [options, {}];
      const s = of(name);
      if (options.ifAvailable && s.busy) return Promise.resolve().then(() => fn(null));
      return new Promise((resolve, reject) => {
        const start = async () => {
          s.busy = true;
          try {
            resolve(await fn({ name }));
          } catch (err) {
            reject(err);
          } finally {
            s.busy = false;
            s.waiters.shift()?.();
          }
        };
        if (!s.busy) return void start();
        s.waiters.push(start);
        options.signal?.addEventListener('abort', () => {
          const i = s.waiters.indexOf(start);
          if (i < 0) return;
          s.waiters.splice(i, 1);
          reject(new DOMException('The lock request was aborted.', 'AbortError'));
        });
      });
    },
  };
  navigator.locks = locks;
  return {
    hold(name) {
      let release;
      const held = new Promise((r) => locks.request(name, {}, () => new Promise((done) => ((release = done), r()))));
      return held.then(() => release);
    },
    remove() {
      delete navigator.locks;
    },
  };
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
  delete navigator.locks;
  handler = () => json(200, { ok: true });
  localStorage.clear();
  navigator.onLine = true;
  doc.visibilityState = 'visible';
}
