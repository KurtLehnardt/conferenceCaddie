// scripts/carry-forward-bundles.mjs and scripts/pages-landing.mjs read their environment overrides
// (CADDIE_BUNDLE_BASE, CADDIE_SITE_URL) when the arguments are parsed, not when the module is
// imported, as build-bundles.mjs does: a value set after the import is the one used, a flag still
// wins over it, and importing either module runs nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const saved = { base: process.env.CADDIE_BUNDLE_BASE, site: process.env.CADDIE_SITE_URL };
delete process.env.CADDIE_BUNDLE_BASE;
delete process.env.CADDIE_SITE_URL;
const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = async () => {
  fetched++;
  throw new Error('no network in this test');
};
const carry = await import('../carry-forward-bundles.mjs');
const landing = await import('../pages-landing.mjs');
globalThis.fetch = realFetch;

const restore = () => {
  for (const [name, value] of [['CADDIE_BUNDLE_BASE', saved.base], ['CADDIE_SITE_URL', saved.site]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

test('importing the carry-forward script runs nothing', () => {
  assert.equal(fetched, 0);
});

test('carry-forward reads CADDIE_BUNDLE_BASE when it parses its arguments', (t) => {
  t.after(restore);
  assert.equal(carry.parseArgs([]).baseUrl, 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/');
  process.env.CADDIE_BUNDLE_BASE = 'https://fork.example.org/caddie/bundles/';
  assert.equal(carry.parseArgs([]).baseUrl, 'https://fork.example.org/caddie/bundles/');
  assert.equal(carry.parseArgs(['--base-url', 'https://other.example.org/b/']).baseUrl, 'https://other.example.org/b/');
  process.env.CADDIE_BUNDLE_BASE = 'http://not-https.example.org/';
  assert.throws(() => carry.parseArgs([]), /--base-url must be an https URL/);
});

test('the landing page reads CADDIE_SITE_URL when it is needed', (t) => {
  t.after(restore);
  assert.equal(landing.parseArgs(['--out', 'x']).siteUrl, 'https://kurtlehnardt.github.io/conferenceCaddie/');
  process.env.CADDIE_SITE_URL = 'https://fork.example.org/caddie/';
  assert.equal(landing.parseArgs(['--out', 'x']).siteUrl, 'https://fork.example.org/caddie/');
  assert.equal(landing.parseArgs(['--out', 'x', '--site-url', 'https://other.example.org/s/']).siteUrl, 'https://other.example.org/s/');
  assert.match(landing.landingPage(null), /href="https:\/\/fork\.example\.org\/caddie\/conferences\.json"/);
});
