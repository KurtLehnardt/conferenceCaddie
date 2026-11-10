#!/usr/bin/env node
// Writes the demo QR code for the app's KubeCon NA 2026 link, after the Worker is deployed:
// docs/demo/qr-kubecon.png (1280 px) and docs/demo/qr-kubecon.svg, high error correction, for
// <app URL>/e/kubecon-cloudnativecon-north-america-2026.
//
// Usage, from the repository root:
//   node worker/scripts/make-qr.mjs --app-url https://conference-caddie.<subdomain>.workers.dev
//   CADDIE_APP_URL=https://conference-caddie.<subdomain>.workers.dev node worker/scripts/make-qr.mjs
// Options:
//   --app-url <url>   the app URL that worker/scripts/deploy.sh printed (or CADDIE_APP_URL). It
//                     must be https, with no user name, password, query or fragment.
//   --slug <slug>     another conference instead of KubeCon NA 2026 (the files keep their names).
//   --out-dir <dir>   where to write the two files (default docs/demo).
//
// The QR code library runs as a one-off, pinned npx tool (qrcode, its command line), so the
// repository gains no dependency. Arguments go to npx as an argument list, never through a shell.

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QR_TOOL = 'qrcode@1.5.4';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = { appUrl: process.env.CADDIE_APP_URL ?? '', slug: 'kubecon-cloudnativecon-north-america-2026', outDir: join(ROOT, 'docs', 'demo') };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value.`);
    return v;
  };
  if (a === '--app-url') opts.appUrl = value();
  else if (a === '--slug') opts.slug = value();
  else if (a === '--out-dir') opts.outDir = resolve(value());
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node worker/scripts/make-qr.mjs --app-url https://conference-caddie.<subdomain>.workers.dev [--slug <slug>] [--out-dir docs/demo]');
    process.exit(0);
  } else fail(`Unknown argument: ${a}`);
}

let base;
try {
  const u = new URL(String(opts.appUrl).trim());
  if (u.protocol !== 'https:') fail('The app URL must use https.');
  if (u.username || u.password || u.search || u.hash) fail('The app URL must have no user name, password, query or fragment.');
  base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
} catch {
  fail('Give the app URL that deploy.sh printed: --app-url https://conference-caddie.<subdomain>.workers.dev (or CADDIE_APP_URL).');
}
if (!SLUG_RE.test(opts.slug)) fail('--slug must be a conference slug.');

const link = `${base}/e/${opts.slug}`;
mkdirSync(opts.outDir, { recursive: true });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const [file, extra] of [
  ['qr-kubecon.png', ['--type', 'png', '--width', '1280']],
  ['qr-kubecon.svg', ['--type', 'svg']],
]) {
  const out = join(opts.outDir, file);
  const r = spawnSync(npx, ['--yes', QR_TOOL, '--error', 'H', '--qzone', '4', ...extra, '--output', out, link], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) fail(`${QR_TOOL} failed for ${file} (exit ${r.status}):\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-10).join('\n')}`);
  console.log(`Wrote ${out.startsWith(ROOT) ? out.slice(ROOT.length + 1) : out}`);
}
console.log(`The QR code opens ${link}`);
