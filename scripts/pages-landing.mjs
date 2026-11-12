#!/usr/bin/env node
// Writes the landing page of the GitHub Pages site (index.html, and the same page as 404.html).
//
// The Pages site holds only the public talk bundles (bundles/, conferences.json and the tier 1
// capabilities.json). The web app is served by the Cloudflare Worker on its own origin, because
// the github.io origin is shared with the account's other Pages sites, which could read the app's
// device secrets from localStorage there (DECISIONS.md, 2026-11-10). So this page holds no app
// code: no script at all (its Content-Security-Policy forbids scripts), no storage access, and no
// form. It links to the app, or says the app is not live yet when no app URL is given. The 404
// page is the same, so an old link or QR code under the Pages address still leads to the app.
// It also writes privacy.html, the apps' privacy policy (scripts/lib/privacy-page.mjs), which the
// store listings link to, with the same restrictions.
//
// Usage: node scripts/pages-landing.mjs --out dist-pages [--app-url https://conference-caddie.<subdomain>.workers.dev]
//                                       [--site-url <the Pages site's https address>]
//                                       [--repo-url https://github.com/<owner>/<repository>]
//   --app-url (or the environment variable CADDIE_APP_URL) must be an https URL with no user name,
//   password, query or fragment; only its origin and path are used. An empty value means "not live".
//   --site-url is the Pages site's own address (default: the environment variable CADDIE_SITE_URL,
//   else the official one). The links to its files are absolute, so they also work from the 404 page,
//   which GitHub serves at any missing path. Both variables are read when they are needed, not when
//   the module is imported, as build-bundles.mjs reads its environment.
//   --repo-url is the repository on GitHub whose issues the privacy page names as the contact
//   (default: the official repository).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OFFICIAL_REPO_URL, normaliseRepoUrl, privacyPage } from './lib/privacy-page.mjs';

const KUBECON = 'kubecon-cloudnativecon-north-america-2026';
const OFFICIAL_SITE_URL = 'https://kurtlehnardt.github.io/conferenceCaddie/';
// The site address when none is given: CADDIE_SITE_URL, else the official one.
export const defaultSiteUrl = () => process.env.CADDIE_SITE_URL || OFFICIAL_SITE_URL;

// The app's base URL without a trailing slash, or null for an empty value. Throws on a bad URL.
export function normaliseAppUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('The app URL is not a valid URL.');
  }
  if (u.protocol !== 'https:') throw new Error('The app URL must use https.');
  if (u.username || u.password || u.search || u.hash) throw new Error('The app URL must have no user name, password, query or fragment.');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function landingPage(appUrl, siteUrl = defaultSiteUrl()) {
  const app = appUrl ? escapeHtml(appUrl) : null;
  const site = normaliseAppUrl(siteUrl);
  if (!site) throw new Error('The site URL must not be empty.');
  const files = escapeHtml(`${site}/`);
  const body = app
    ? `<p>The app lives at its own address:</p>
    <p class="cta"><a href="${app}/">Open Conference Caddie</a></p>
    <p>KubeCon + CloudNativeCon North America 2026: <a href="${app}/e/${KUBECON}">${app}/e/${KUBECON}</a></p>`
    : `<p>The app is not live yet. Its address will be published here once it is deployed.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <title>Conference Caddie</title>
    <style>
      :root { color-scheme: light dark; --fg: #1d2330; --muted: #5a6273; --bg: #f5f6f8; --link: #1f5fbf; }
      @media (prefers-color-scheme: dark) { :root { --fg: #e8eaef; --muted: #a3aab8; --bg: #14171d; --link: #8db7ff; } }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { max-width: 36rem; margin: 0 auto; padding: 2.5rem 1rem; overflow-wrap: anywhere; }
      h1 { font-size: 1.6rem; margin: 0 0 1rem; }
      a { color: var(--link); }
      .cta a { display: inline-block; padding: 0.7rem 1.1rem; border-radius: 0.6rem; background: var(--link); color: var(--bg); font-weight: 600; text-decoration: none; }
      .small { color: var(--muted); font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Conference Caddie</h1>
      <p>Find the people to talk to and the talks you would like at Linux Foundation conferences.</p>
    ${body}
      <p class="small">This site publishes only the public talk data: <a href="${files}conferences.json">conferences.json</a>, <a href="${files}capabilities.json">capabilities.json</a> and the talk bundles under <code>bundles/</code>. Source: <a href="https://github.com/KurtLehnardt/conferenceCaddie">KurtLehnardt/conferenceCaddie</a>.</p>
      <p class="small"><a href="${files}privacy.html">Privacy policy</a></p>
    </main>
  </body>
</html>
`;
}

export function parseArgs(argv) {
  const out = { out: null, appUrl: process.env.CADDIE_APP_URL ?? '', siteUrl: defaultSiteUrl(), repoUrl: OFFICIAL_REPO_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--app-url') out.appUrl = argv[++i] ?? '';
    else if (a === '--site-url') out.siteUrl = argv[++i] ?? '';
    else if (a === '--repo-url') out.repoUrl = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.out) throw new Error('--out <dir> is required.');
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const appUrl = normaliseAppUrl(args.appUrl);
    const dir = resolve(args.out);
    mkdirSync(dir, { recursive: true });
    const html = landingPage(appUrl, args.siteUrl);
    const site = normaliseAppUrl(args.siteUrl);
    if (!site) throw new Error('The site URL must not be empty.');
    const privacy = privacyPage(`${site}/`, normaliseRepoUrl(args.repoUrl));
    writeFileSync(join(dir, 'index.html'), html);
    writeFileSync(join(dir, '404.html'), html);
    writeFileSync(join(dir, 'privacy.html'), privacy);
    console.log(appUrl ? `Wrote the landing page linking to ${appUrl}/.` : 'Wrote the landing page: the app is not live yet.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
