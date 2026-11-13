// The privacy page (scripts/lib/privacy-page.mjs), published as privacy.html by
// scripts/pages-landing.mjs: it holds no script and the same Content-Security-Policy as the landing
// page, names the repository's issues as the contact, names the server the apps use by default,
// and the landing page links to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_SERVER_HOST, normaliseEmail, normaliseRepoUrl, privacyPage } from '../lib/privacy-page.mjs';
import { defaultSiteUrl, landingPage } from '../pages-landing.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SITE = 'https://kurtlehnardt.github.io/conferenceCaddie/';

test('the privacy page holds no script, no event handler and a default-src none policy', () => {
  const html = privacyPage(SITE);
  assert.doesNotMatch(html, /<script|\son[a-z]+\s*=/i);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<form|<iframe|<img|<link /i);
});

test('the privacy page names the repository issues as its contact and links home', () => {
  const html = privacyPage(SITE, 'https://github.com/someone/caddie-fork/');
  assert.match(html, /href="https:\/\/github\.com\/someone\/caddie-fork\/issues"/);
  assert.match(html, /href="https:\/\/kurtlehnardt\.github\.io\/conferenceCaddie\/"/);
  assert.match(html, /id="delete"/);
  assert.match(html, /id="contact"/);
});

test('a contact email is named only when given, and must be a plain address', () => {
  assert.doesNotMatch(privacyPage(SITE), /mailto:/);
  const html = privacyPage(SITE, undefined, 'privacy@example.org');
  assert.match(html, /href="mailto:privacy@example\.org"/);
  assert.match(html, /issues/);
  assert.equal(normaliseEmail(''), null);
  assert.equal(normaliseEmail(' a.b+c@example.org '), 'a.b+c@example.org');
  for (const bad of ['no-at-sign', 'a@b', 'a b@example.org', 'a@example.org?subject=x', '"><script>@x.org', 'a%0Abcc@x.org', '.a..b@x.org', 'a@-x-.org']) {
    assert.throws(() => normaliseEmail(bad), /plain email address/, bad);
  }
});

test('Settings in the apps opens this page', () => {
  const strings = readFileSync(join(root, 'native/composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/strings/Strings.kt'), 'utf8');
  const url = strings.match(/const val PRIVACY_URL = "([^"]+)"/);
  assert.ok(url, 'Strings.Settings.PRIVACY_URL not found');
  assert.equal(url[1], `${defaultSiteUrl()}privacy.html`);
});

test('the repository address must be a GitHub repository over https', () => {
  assert.equal(normaliseRepoUrl('https://github.com/a/b/'), 'https://github.com/a/b');
  for (const bad of ['http://github.com/a/b', 'https://example.org/a/b', 'https://github.com/a', 'https://github.com/a/b?x=1', 'https://github.com/a/b/c', '']) {
    assert.throws(() => normaliseRepoUrl(bad), /repository URL/, bad);
  }
});

test('the privacy page names the backend the apps use by default', () => {
  const core = readFileSync(join(root, 'native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/core/CaddieCore.kt'), 'utf8');
  const backend = core.match(/const val BACKEND = "https:\/\/([^"/]+)"/);
  assert.ok(backend, 'Defaults.BACKEND not found in CaddieCore.kt');
  assert.equal(OFFICIAL_SERVER_HOST, backend[1], 'Update OFFICIAL_SERVER_HOST and the Service providers section of privacy-page.mjs.');
  assert.ok(privacyPage(SITE).includes(OFFICIAL_SERVER_HOST));
});

test('the landing page links to the privacy page', () => {
  assert.match(landingPage(null, SITE), /href="https:\/\/kurtlehnardt\.github\.io\/conferenceCaddie\/privacy\.html"/);
});

test('pages-landing.mjs writes index.html, 404.html and privacy.html', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(root, 'scripts/pages-landing.mjs'), '--out', dir, '--site-url', SITE, '--app-url', '', '--repo-url', 'https://github.com/someone/fork', '--contact-email', ''], {
    env: { ...process.env, CADDIE_APP_URL: '' },
  });
  assert.deepEqual(readdirSync(dir).sort(), ['404.html', 'index.html', 'privacy.html']);
  assert.match(readFileSync(join(dir, 'privacy.html'), 'utf8'), /github\.com\/someone\/fork\/issues/);
  assert.throws(
    () => execFileSync(process.execPath, [join(root, 'scripts/pages-landing.mjs'), '--out', dir, '--site-url', SITE, '--repo-url', 'https://evil.example/x/y'], { stdio: 'pipe' }),
    /Command failed/,
  );
  assert.throws(
    () => execFileSync(process.execPath, [join(root, 'scripts/pages-landing.mjs'), '--out', dir, '--site-url', SITE, '--contact-email', 'not an address'], { stdio: 'pipe' }),
    /Command failed/,
  );
});
