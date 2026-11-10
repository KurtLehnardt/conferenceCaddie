// The talks routes of the ConferenceDO (PLAN sections 1.7 and 2, rows 2 and 4 to 10), with the
// request and response shapes, error messages and per-address rate limits of today's server.
// The Worker has already resolved and checked the conference slug, applied the body cap, and
// refused a foreign Origin on the routes that need it.

import { HttpError, json, readJson } from '../lib/http.js';
import { validate as validateSearch, search } from './search.js';
import { validate as validateSchedule, scheduleJson } from './schedule.js';
import { validate as validateRelated, related } from './related.js';
import { validate as validateRecommend, recommend } from './recommend.js';
import { listTopics, suggestTopics, validateSuggest } from './topics.js';
import { validate as validateImport, runImport, RATE_MESSAGE } from './import.js';
import { validate as validateGithub, proposeFromGithub, RATE_LIMIT, RATE_WINDOW_MS } from './github.js';

const PER_MIN = 60;
const SCHEDULE_PER_MIN = 20;
const IMPORT_PER_MIN = 10;

async function handleSearch(ctx, req) {
  ctx.limit(`search:${ctx.ip}`, PER_MIN);
  const params = validateSearch(ctx, await readJson(req));
  return json(200, await search(ctx, params));
}

async function handleSchedule(ctx, req) {
  ctx.limit(`schedule:${ctx.ip}`, SCHEDULE_PER_MIN);
  validateSchedule(new URL(req.url));
  return new Response(scheduleJson(ctx.store, ctx.slug), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleRelated(ctx, req) {
  ctx.limit(`related:${ctx.ip}`, PER_MIN);
  const results = related(ctx.store, validateRelated(new URL(req.url)));
  if (results === null) return json(404, { error: 'Talk not found' });
  return json(200, { results }, { 'Cache-Control': 'private, max-age=300' });
}

async function handleRecommendations(ctx, req) {
  ctx.limit(`recs:${ctx.ip}`, PER_MIN);
  const params = validateRecommend(await readJson(req));
  if (!params.learn.length && !params.interests) return json(200, { results: [], needs_profile: true });
  const { results, degraded } = await recommend(ctx, params);
  // degraded is present only when the interests text was matched by keywords alone.
  return json(200, degraded ? { results, degraded: { semantic: true } } : { results });
}

async function handleTopics(ctx, req) {
  ctx.limit(`topics:${ctx.ip}`, PER_MIN);
  const url = new URL(req.url);
  const result = listTopics(ctx.store, url);
  const q = (url.searchParams.get('q') ?? '').trim();
  return json(200, result, q ? {} : { 'Cache-Control': 'public, max-age=300' });
}

async function handleSuggest(ctx, req) {
  ctx.limit(`suggest:${ctx.ip}`, PER_MIN);
  return json(200, suggestTopics(ctx.store, validateSuggest(await readJson(req))));
}

async function handleImport(ctx, req) {
  try {
    ctx.limit(`import:${ctx.ip}`, IMPORT_PER_MIN);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) throw new HttpError(429, { error: RATE_MESSAGE }, err.headers);
    throw err;
  }
  const params = validateImport(await readJson(req));
  return json(200, runImport(ctx, params));
}

async function handleGithub(ctx, req) {
  ctx.limit(`github:${ctx.ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  const handle = validateGithub(await readJson(req));
  return json(200, { ok: true, proposal: await proposeFromGithub(ctx, handle) });
}

export default [
  { method: 'POST', path: '/api/search', bucket: 'public', fail: 'Search is temporarily unavailable', handler: handleSearch },
  { method: 'GET', path: '/api/schedule', bucket: 'public', fail: 'The schedule is temporarily unavailable', handler: handleSchedule },
  { method: 'GET', path: '/api/related', bucket: 'public', fail: 'Related talks is temporarily unavailable', handler: handleRelated },
  { method: 'POST', path: '/api/recommendations', bucket: 'public', fail: 'Recommendations is temporarily unavailable', handler: handleRecommendations },
  { method: 'GET', path: '/api/topics', bucket: 'public', fail: 'Topics is temporarily unavailable', handler: handleTopics },
  { method: 'POST', path: '/api/topics/suggest', bucket: 'public', fail: 'Topic suggestions is temporarily unavailable', handler: handleSuggest },
  { method: 'POST', path: '/api/import/schedule', bucket: 'public', fail: 'Import is temporarily unavailable. Please try again.', handler: handleImport },
  { method: 'POST', path: '/api/import/github', bucket: 'public', fail: 'upstream', handler: handleGithub },
];
