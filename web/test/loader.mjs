// Module hooks that let Node run web/src modules as they are, with Node's own type stripping:
// - a relative import without an extension (Vite's style) resolves to the .ts file next to it;
// - import.meta.env, which Vite fills in at build time, is set to a production-like value.
// Only files under web/src are touched. Files with JSX (.tsx) cannot run this way and are not used
// by the tests. register.mjs installs these hooks.
const SRC = new URL('../src/', import.meta.url).href;
const ENV = "import.meta.env = { DEV: false, PROD: true, MODE: 'test' };\n";

function rewrite(specifier, context) {
  const fromSrc = context.parentURL?.startsWith(SRC);
  return fromSrc && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) ? `${specifier}.ts` : specifier;
}

function withEnv(url, result) {
  if (!url.startsWith(SRC) || !url.endsWith('.ts')) return result;
  return { ...result, source: ENV + String(result.source) };
}

/** For module.registerHooks, which runs the hooks in this thread and synchronously. */
export const syncHooks = {
  resolve: (specifier, context, nextResolve) => nextResolve(rewrite(specifier, context), context),
  load: (url, context, nextLoad) => withEnv(url, nextLoad(url, context)),
};

/** For module.register, on Node versions without registerHooks. */
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(rewrite(specifier, context), context);
}

export async function load(url, context, nextLoad) {
  return withEnv(url, await nextLoad(url, context));
}
