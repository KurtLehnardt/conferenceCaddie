// Conference Caddie HTTP server: serves the built web app and the search API from one origin.
//
// Env: PORT (default 8080), ES_URL, ES_API_KEY, ES_INDEX (default caddie-talks),
//      ES_CONFERENCES_INDEX (default caddie-conferences), ES_TOPICS_INDEX (default caddie-topics),
//      STATIC_DIR (default web/dist), ES_PEOPLE_API_KEY (people, circles and circle counts only),
//      ES_PEOPLE_INDEX (default caddie-people), ES_PEOPLE_BLOCKS_INDEX (default
//      caddie-people-blocks), ES_PEOPLE_MEETS_INDEX (default caddie-people-meets),
//      ES_PEOPLE_REPORTS_INDEX (default caddie-people-reports), ES_PEOPLE_PUSH_INDEX (default
//      caddie-people-push), ES_PEOPLE_NUDGES_INDEX (default caddie-people-nudges), REF_SALT
//      (optional), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (secret) and VAPID_SUBJECT for push nudges,
//      BLE_NEAR_RSSI (default -75, the Bluetooth "a few metres" threshold of ble.mjs), and the
//      filter's ES_RULES_INDEX and MOD_* (moderation.mjs).
//
// The log has one line per request with the method, path, status and duration. It never
// contains headers, bodies, search text or credentials.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { validate, search, BadRequest, UpstreamError } from './search.mjs';
import { publicConferences } from './conferences.mjs';
import { handlePeopleApi } from './people.mjs';
import { handleConnectApi } from './connect.mjs';
import { handleBleApi } from './ble.mjs';
import { handleReportApi } from './report.mjs';
import { handlePushApi } from './push.mjs';
import { handleRecommendationsApi } from './recommend.mjs';
import { handleTopicsApi } from './topics-api.mjs';
import { handleImportGithubApi } from './import-github.mjs';
import { handleSchedule } from './schedule.mjs';
import { take, clientIp } from './ratelimit.mjs';

const PORT = Number(process.env.PORT) || 8080;
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || 'web/dist');
const MAX_BODY = 4096;
// Every text search embeds its query, so searches share the per-address limit of the other
// public endpoints.
const SEARCH_PER_MIN = 60;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

if (!process.env.ES_API_KEY) console.warn('ES_API_KEY is not set; searches will fail.');

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) {
      reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

async function handleSearch(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    return;
  }
  const rate = take(`search:${clientIp(req)}`, SEARCH_PER_MIN);
  if (!rate.ok) {
    sendJson(res, 429, { error: 'Too many requests' }, { 'Retry-After': String(rate.retryAfterSec) });
    return;
  }
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return;
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.status === 413 ? 'Request body is too large' : 'Could not read the request body' }, { Connection: 'close' });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Malformed JSON' });
    return;
  }
  try {
    const params = await validate(body);
    const result = await search(params);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof BadRequest) {
      sendJson(res, 400, { error: err.message });
    } else if (err instanceof UpstreamError) {
      console.error(`Elasticsearch request failed: ${err.message}`);
      sendJson(res, 502, { error: 'Search is temporarily unavailable' });
    } else {
      console.error(`Search handler error: ${err?.name ?? 'Error'}`);
      sendJson(res, 502, { error: 'Search is temporarily unavailable' });
    }
  }
}

async function handleConferences(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
    return;
  }
  try {
    const conferences = await publicConferences();
    sendJson(res, 200, { conferences }, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    console.error(`Elasticsearch request failed: ${err instanceof UpstreamError ? err.message : 'error'}`);
    sendJson(res, 502, { error: 'Conferences are temporarily unavailable' });
  }
}

function sendFile(req, res, filePath, cacheControl) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function cacheControlFor(rel) {
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  // The service worker script must be checked on every load, so a new build replaces it.
  if (rel === 'index.html' || rel === 'manifest.webmanifest' || rel === 'sw.js') return 'no-cache';
  return 'public, max-age=3600';
}

function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'Bad path' });
    return;
  }
  if (decoded.includes('\0')) {
    sendJson(res, 400, { error: 'Bad path' });
    return;
  }
  let rel = path.posix.normalize(decoded).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const filePath = path.resolve(STATIC_DIR, rel);
  if (filePath !== STATIC_DIR && !filePath.startsWith(STATIC_DIR + path.sep)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(req, res, filePath, cacheControlFor(rel));
      return;
    }
    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (acceptsHtml && !rel.startsWith('assets/')) {
      sendFile(req, res, path.join(STATIC_DIR, 'index.html'), 'no-cache');
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  });
}

const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    /* keep "/" */
  }
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (pathname === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Use GET' }, { Allow: 'GET, HEAD' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === '/api/search') {
    handleSearch(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { error: 'Search is temporarily unavailable' });
    });
    return;
  }
  if (pathname === '/api/conferences') {
    handleConferences(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { error: 'Conferences are temporarily unavailable' });
    });
    return;
  }
  if (pathname === '/api/schedule') {
    handleSchedule(req, res, new URL(req.url || '/', 'http://localhost')).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { error: 'The schedule is temporarily unavailable' });
      else res.destroy();
    });
    return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    handleApi(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 502, { error: 'Service is temporarily unavailable' });
      else res.destroy();
    });
    return;
  }
  handleStatic(req, res, pathname);
});

// The people, circles, blocks, presence, meets, reports, push, recommendations and topics routes. Each handler
// reads its own body with its own size limit and resolves to true when it handled the request.
async function handleApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (await handlePeopleApi(req, res, url)) return;
  if (await handleConnectApi(req, res, url)) return;
  if (await handleBleApi(req, res, url)) return;
  if (await handleReportApi(req, res, url)) return;
  if (await handlePushApi(req, res, url)) return;
  if (await handleRecommendationsApi(req, res, url)) return;
  if (await handleTopicsApi(req, res, url)) return;
  if (await handleImportGithubApi(req, res, url)) return;
  sendJson(res, 404, { error: 'Not found' });
}

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
