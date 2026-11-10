import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The server's Content-Security-Policy (server/index.mjs) without frame-ancestors, which a meta tag
// cannot carry (theme-init.js guards against framing instead), and with the API origin allowed in
// connect-src, because the API is on another origin on GitHub Pages.
function cspFor(apiOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Build settings for hosting the app away from Cloud Run, for example on GitHub Pages:
 * - With VITE_API_BASE set, a Content-Security-Policy <meta> is made the first child of <head>,
 *   because a meta policy applies only to what follows it. Cloud Run keeps the server's header.
 * - With a VITE_BASE other than "/", dist/index.html is copied to dist/404.html, so a deep link such
 *   as /conferenceCaddie/e/{slug}#/people boots the app on a host with no server-side routes, and
 *   dist/.nojekyll is written so Pages serves every file as it is.
 * With neither variable set, the build output is the same as it always was.
 */
function hosting(base: string, apiBase: string): Plugin {
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
        const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(origin)}" />`;
        return html.replace(/<head([^>]*)>/i, (open) => `${open}\n    ${meta}`);
      },
    },
    writeBundle() {
      if (base === '/') return;
      const dir = resolve(root, outDir);
      const index = resolve(dir, 'index.html');
      if (existsSync(index)) copyFileSync(index, resolve(dir, '404.html'));
      writeFileSync(resolve(dir, '.nojekyll'), '');
    },
  };
}

// Preact uses the automatic JSX runtime; no framework plugin is needed.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  // The path the app is served under: always a leading and a trailing slash, "/" by default.
  const rawBase = (env.VITE_BASE || '/').trim();
  const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const apiBase = (env.VITE_API_BASE || '').trim().replace(/\/+$/, '');
  return {
    base,
    plugins: [hosting(base, apiBase)],
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
    },
  };
});
