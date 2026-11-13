// Module hooks that let Node run web/src modules as they are, with Node's own type stripping:
// - a relative import without an extension (Vite's style) resolves to the .ts file next to it, or
//   to the .tsx file when there is no .ts one;
// - a .tsx file is compiled with the JSX transform the build uses (Preact's automatic runtime,
//   through Vite's own compiler, rolldown, a devDependency pinned to the version Vite resolves),
//   so the render tests can draw the screens (dom.mjs);
// - a stylesheet import (`import './people.css'`) loads as an empty module;
// - import.meta.env, which Vite fills in at build time, is set to a production-like value;
// - a module imported with a query, such as `sync.ts?tab=b`, passes the query on to the modules
//   it imports, so a test gets a second, separate copy of the app's modules, as a second browser
//   tab has. Both copies share localStorage, fetch and Web Locks, as tabs do.
// Only files under web/src are touched. register.mjs installs these hooks.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';

const SRC = new URL('../src/', import.meta.url).href;
const ENV = "import.meta.env = { DEV: false, PROD: true, MODE: 'test' };\n";

function rewrite(specifier, context) {
  const fromSrc = context.parentURL?.startsWith(SRC);
  if (!fromSrc || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]sx?$/.test(specifier) || /\.css$/.test(specifier)) return specifier;
  const tsx = new URL(`${specifier}.tsx`, context.parentURL);
  return !existsSync(new URL(`${specifier}.ts`, context.parentURL)) && existsSync(tsx) ? `${specifier}.tsx` : `${specifier}.ts`;
}

/** A stylesheet or a .tsx file under web/src, loaded as the build would, or null for anything else. */
function loadSource(url) {
  const path = url.split('?')[0];
  if (!path.startsWith(SRC)) return null;
  if (path.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (!path.endsWith('.tsx')) return null;
  const file = fileURLToPath(path);
  const out = transformSync(file, readFileSync(file, 'utf8'), { jsx: { runtime: 'automatic', importSource: 'preact' } });
  if (out.errors?.length) throw new Error(`${file}: ${out.errors.map((e) => e.message).join('; ')}`);
  return { format: 'module', source: ENV + out.code, shortCircuit: true };
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
  load: (url, context, nextLoad) => loadSource(url) ?? withEnv(url, nextLoad(url, context)),
};

/** For module.register, on Node versions without registerHooks. */
export async function resolve(specifier, context, nextResolve) {
  return withQuery(await nextResolve(rewrite(specifier, context), context), specifier, context);
}

export async function load(url, context, nextLoad) {
  return loadSource(url) ?? withEnv(url, await nextLoad(url, context));
}
