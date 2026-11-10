// Module hooks that let Node run web/src modules as they are, with Node's own type stripping:
// - a relative import without an extension (Vite's style) resolves to the .ts file next to it;
// - import.meta.env, which Vite fills in at build time, is set to a production-like value;
// - a module imported with a query, such as `sync.ts?tab=b`, passes the query on to the modules
//   it imports, so a test gets a second, separate copy of the app's modules, as a second browser
//   tab has. Both copies share localStorage, fetch and Web Locks, as tabs do.
// Only files under web/src are touched. Files with JSX (.tsx) cannot run this way and are not used
// by the tests. register.mjs installs these hooks.
const SRC = new URL('../src/', import.meta.url).href;
const ENV = "import.meta.env = { DEV: false, PROD: true, MODE: 'test' };\n";

function rewrite(specifier, context) {
  const fromSrc = context.parentURL?.startsWith(SRC);
  return fromSrc && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) ? `${specifier}.ts` : specifier;
}

/** The parent's query, carried over to a relative import inside web/src. */
function withQuery(result, specifier, context) {
  const parent = context.parentURL ?? '';
  const query = parent.startsWith(SRC) ? new URL(parent).search : '';
  if (!query || !/^\.\.?\//.test(specifier) || !result.url.startsWith(SRC) || result.url.includes('?')) return result;
  return { ...result, url: result.url + query };
}

function withEnv(url, result) {
  const path = url.split('?')[0];
  if (!path.startsWith(SRC) || !path.endsWith('.ts')) return result;
  return { ...result, source: ENV + String(result.source) };
}

/** For module.registerHooks, which runs the hooks in this thread and synchronously. */
export const syncHooks = {
  resolve: (specifier, context, nextResolve) => withQuery(nextResolve(rewrite(specifier, context), context), specifier, context),
  load: (url, context, nextLoad) => withEnv(url, nextLoad(url, context)),
};

/** For module.register, on Node versions without registerHooks. */
export async function resolve(specifier, context, nextResolve) {
  return withQuery(await nextResolve(rewrite(specifier, context), context), specifier, context);
}

export async function load(url, context, nextLoad) {
  return withEnv(url, await nextLoad(url, context));
}
