import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The Cloud Run server's Content-Security-Policy (server/index.mjs). connect-src is 'self' because
// the API is on the app's own origin, both on Cloud Run and on the Cloudflare Worker.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
];

// The same policy for a <meta> tag, for a build whose API is on another origin (VITE_API_BASE): a
// meta policy cannot carry frame-ancestors (theme-init.js guards against framing instead), and
// connect-src must name the API origin.
function metaCspFor(apiOrigin: string): string {
  return CSP_DIRECTIVES.filter((d) => !d.startsWith('frame-ancestors'))
    .map((d) => (d.startsWith('connect-src') ? `connect-src 'self' ${apiOrigin}` : d))
    .join('; ');
}

// The _headers file of the Worker-mode build. Cloudflare's asset layer applies it to every static
// file it serves, and to index.html when it answers an app route such as /e/{slug}
// (not_found_handling = "single-page-application" in worker/wrangler.toml). The security headers
// are those the Cloud Run server sends. Cache-Control mirrors the server's: the hashed files under
// /assets/ are immutable, the icons keep for an hour, and everything else (index.html, sw.js, the
// manifest, theme-init.js) is revalidated on every load, so a new deploy reaches the app and
// replaces the service worker.
//
// The immutable rule names each hashed file of this build rather than /assets/*: the asset layer
// answers a path with no file, such as a chunk of an older build, with index.html, and that answer
// must not be cached for a year under a name a later build (a rollback) may use again. The asset
// layer applies every matching rule in file order and appends a header that an earlier rule
// already set, so the later rules first remove Cache-Control.
const HEADER_RULES_MAX = 100; // Cloudflare's limit on _headers rules
function workerHeaders(assetFiles: string[]): string {
  const security = [
    `Content-Security-Policy: ${CSP_DIRECTIVES.join('; ')}`,
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Strict-Transport-Security: max-age=31536000',
    'Permissions-Policy: geolocation=(self), camera=(), microphone=()',
  ];
  const rule = (path: string, lines: string[]) => [path, ...lines.map((l) => `  ${l}`)].join('\n');
  const rules = [
    rule('/*', [...security, 'Cache-Control: no-cache']),
    rule('/icons/*', ['! Cache-Control', 'Cache-Control: public, max-age=3600']),
    ...assetFiles.map((f) => rule(`/assets/${f}`, ['! Cache-Control', 'Cache-Control: public, max-age=31536000, immutable'])),
  ];
  if (rules.length > HEADER_RULES_MAX) {
    throw new Error(`The Worker-mode build has ${assetFiles.length} files in assets/, more than the ${HEADER_RULES_MAX - 2} that _headers can name one by one.`);
  }
  return ['# Written by the Worker-mode build (web/vite.config.ts). Do not edit by hand.', ...rules, ''].join('\n');
}

/**
 * Build settings per host:
 * - The default build (npm run build, used by Cloud Run) is served by server/index.mjs, which sends
 *   the security headers itself, at base "/" with the API on the same origin.
 * - The Worker-mode build (npm run build:worker, which is `vite build --mode worker`) goes to
 *   dist-worker/ for the Cloudflare Worker's static assets, also at base "/" with a same-origin
 *   API and the in-browser document reader, and writes dist-worker/_headers (see workerHeaders).
 * - With VITE_API_BASE set (an API on another origin, which no deployment uses today), a
 *   Content-Security-Policy <meta> naming that origin is made the first child of <head>, because a
 *   meta policy applies only to what follows it.
 */
function hosting(apiBase: string, worker: boolean): Plugin {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'caddie-hosting',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!apiBase) return html;
        const origin = new URL(apiBase).origin;
        const meta = `<meta http-equiv="Content-Security-Policy" content="${metaCspFor(origin)}" />`;
        return html.replace(/<head([^>]*)>/i, (open) => `${open}\n    ${meta}`);
      },
    },
    writeBundle() {
      if (!worker) return;
      const dir = resolve(root, outDir);
      const assetsDir = resolve(dir, 'assets');
      const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => /^[A-Za-z0-9._-]+$/.test(f)).sort() : [];
      writeFileSync(resolve(dir, '_headers'), workerHeaders(assetFiles));
    },
  };
}

// Preact uses the automatic JSX runtime; no framework plugin is needed.
export default defineConfig(({ mode }) => {
  const worker = mode === 'worker';
  if (worker) {
    // The Worker serves the app at "/" with the API on the same origin, and has no Elasticsearch
    // to read PDF and document files, so the app reads them in the browser
    // (src/components/extract.ts). These are set before Vite reads the VITE_ variables, so a value
    // left in the shell cannot leak into this build.
    process.env.VITE_BASE = '/';
    process.env.VITE_API_BASE = '';
    process.env.VITE_CLIENT_EXTRACT = '1';
  }
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  // The path the app is served under: always a leading and a trailing slash, "/" by default.
  const rawBase = (env.VITE_BASE || '/').trim();
  const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const apiBase = (env.VITE_API_BASE || '').trim().replace(/\/+$/, '');
  return {
    base,
    plugins: [hosting(apiBase, worker)],
    oxc: {
      jsx: { runtime: 'automatic', importSource: 'preact' },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      proxy: {
        '/api': 'http://localhost:8080',
      },
    },
    build: {
      target: 'es2020',
      outDir: worker ? 'dist-worker' : 'dist',
    },
  };
});
