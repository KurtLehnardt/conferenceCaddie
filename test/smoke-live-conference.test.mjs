// The live conference of scripts/smoke.mjs (scripts/lib/smoke-live-conference.mjs): which conference the
// clock-dependent checks run against, with a stubbed GET /api/conferences answer and stubbed published
// bundles, and the topics they ask For you for there. Also the PASS, FAIL and SKIP counting of
// scripts/lib/smoke-report.mjs: a skipped check is never counted as passed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_MARGIN_MS, PREFERRED_LEAVE_OUT, cooccurring, leaveOutCase, noTalksToComeWhy, pickLiveConference, rankTopics, talksToCome, whyCases,
} from '../scripts/lib/smoke-live-conference.mjs';
import { SkipCheck, createReporter } from '../scripts/lib/smoke-report.mjs';

const NOW = Date.parse('2026-11-12T23:40:00Z');
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const talk = (slug, i, endMs, kind = 'talk') => ({ talk_id: `${slug}:t${i}`, kind, start: iso(endMs - H / 2), end: iso(endMs) });

const PRIMARY = 'kubecon-cloudnativecon-north-america-2026';
const GRPC = 'grpconf-india-2026';
const MCP = 'mcp-dev-summit-nairobi-2026';
const PYTORCH = 'pytorch-day-japan-2026';
const UNAVAILABLE = 'argocon-north-america-2026';

// A stubbed GET /api/conferences answer, in its order, and the published bundles' items per slug. A slug
// with no bundle makes loadTalks reject, as the smoke's loader does when the index has no bundle for it.
function stubs({ conferences, bundles }) {
  const api = { conferences: conferences.map(([slug, status]) => ({ slug, status, name: slug, talk_count: (bundles[slug] ?? []).length })) };
  const loaded = [];
  const loadTalks = async (slug) => {
    loaded.push(slug);
    if (!(slug in bundles)) throw new Error('the published index has no bundle for it');
    return bundles[slug];
  };
  return { conferences: api.conferences, loadTalks, loaded };
}

const ended = (slug) => [talk(slug, 1, NOW - 2 * H), talk(slug, 2, NOW - H), talk(slug, 3, NOW - 60_000, 'ambient')];
const toCome = (slug) => [talk(slug, 1, NOW - H), talk(slug, 2, NOW + 2 * H), talk(slug, 3, NOW + 3 * H)];
const LIST = [[PRIMARY, 'searchable'], [UNAVAILABLE, 'unavailable'], [GRPC, 'searchable'], [MCP, 'searchable'], [PYTORCH, 'searchable']];

describe('talksToCome and noTalksToComeWhy', () => {
  test('count only talks ending more than the margin after now', () => {
    const docs = [talk('c', 1, NOW + LIVE_MARGIN_MS), talk('c', 2, NOW + LIVE_MARGIN_MS + 1), talk('c', 3, NOW + 5 * H, 'ambient'), talk('c', 4, NOW + 5 * H, 'break')];
    assert.equal(talksToCome(docs, NOW), 1, 'end == now + margin is not to come; other kinds never count');
    assert.equal(talksToCome(docs, NOW, 0), 2);
    assert.equal(talksToCome([], NOW), 0);
  });
  test('say whether every talk has ended, ends within the margin, or there are none', () => {
    assert.equal(noTalksToComeWhy('c', ended('c'), NOW), 'every talk of c has ended');
    assert.equal(noTalksToComeWhy('c', [talk('c', 1, NOW + 60_000)], NOW), 'every talk of c has ended or ends within 15 minutes');
    assert.equal(noTalksToComeWhy('c', [talk('c', 1, NOW + H, 'ambient')], NOW), 'c has no talks');
  });
});

describe('pickLiveConference', () => {
  test('primary live: the primary conference, and no other bundle is read', async () => {
    const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: toCome(PRIMARY), [GRPC]: toCome(GRPC) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, PRIMARY);
    assert.equal(live.source, 'primary');
    assert.equal(live.error, undefined);
    assert.deepEqual(live.primary, { known: true, toCome: 2, why: '' });
    assert.deepEqual(s.loaded, [PRIMARY]);
  });

  test('primary ended, another live: the first searchable conference in the list order with talks to come', async () => {
    // grpconf's bundle is missing, MCP has ended, PyTorch has talks to come: PyTorch, and the run says why.
    const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY), [UNAVAILABLE]: toCome(UNAVAILABLE), [MCP]: ended(MCP), [PYTORCH]: toCome(PYTORCH) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, PYTORCH);
    assert.equal(live.source, 'fallback');
    assert.match(live.why, new RegExp(`^every talk of ${PRIMARY} has ended; ${PYTORCH} is the first searchable conference of GET /api/conferences with talks to come \\(2\\)`));
    assert.match(live.why, new RegExp(`passed over: ${GRPC}: its talks could not be read: the published index has no bundle for it; ${MCP}: every talk of ${MCP} has ended`));
    assert.deepEqual(s.loaded, [PRIMARY, GRPC, MCP, PYTORCH], 'an unavailable conference is never read');
    assert.deepEqual(live.primary, { known: true, toCome: 0, why: `every talk of ${PRIMARY} has ended` });
  });

  test('primary ended, and the first conference after it is live: that one, and the rest are not read', async () => {
    const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY), [GRPC]: toCome(GRPC), [MCP]: toCome(MCP) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, GRPC);
    assert.deepEqual(s.loaded, [PRIMARY, GRPC]);
  });

  test('none live: no conference, and the SKIP reason says so', async () => {
    const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY), [GRPC]: ended(GRPC), [MCP]: [talk(MCP, 1, NOW + 60_000)], [PYTORCH]: [] } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, null);
    assert.equal(live.source, 'none');
    assert.equal(live.error, undefined, 'no conference to come is a SKIP, not a FAIL');
    assert.equal(live.why, `every talk of ${PRIMARY} has ended and no other searchable conference has talks to come`);
  });

  test('none live when the API lists no conference at all', async () => {
    const s = stubs({ conferences: [], bundles: { [PRIMARY]: ended(PRIMARY) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, null);
    assert.equal(live.why, `every talk of ${PRIMARY} has ended and no other searchable conference has talks to come`);
  });

  test('a primary whose last talks end within the margin is not live', async () => {
    const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: [talk(PRIMARY, 1, NOW + 5 * 60_000)], [GRPC]: toCome(GRPC) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, GRPC);
    assert.match(live.why, new RegExp(`^every talk of ${PRIMARY} has ended or ends within 15 minutes; ${GRPC} is`));
  });

  test('a primary whose talks cannot be read is taken as live, as before', async () => {
    const s = stubs({ conferences: LIST, bundles: { [GRPC]: toCome(GRPC) } });
    const live = await pickLiveConference({ primary: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
    assert.equal(live.slug, PRIMARY);
    assert.match(live.why, /its talks could not be read: the published index has no bundle for it, so it is taken as live/);
    assert.equal(live.primary.known, false);
  });

  describe('SMOKE_LIVE_CONFERENCE', () => {
    test('a searchable conference with talks to come is used, even while the primary is live', async () => {
      const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: toCome(PRIMARY), [MCP]: toCome(MCP) } });
      const live = await pickLiveConference({ primary: PRIMARY, override: MCP, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
      assert.equal(live.slug, MCP);
      assert.equal(live.source, 'override');
      assert.equal(live.why, 'SMOKE_LIVE_CONFERENCE, 2 talks to come');
      assert.deepEqual(live.primary, { known: true, toCome: 2, why: '' }, 'the primary is still read for the checks that stay on it');
    });
    test('it is used without the automatic pick even when the conference listed first is live', async () => {
      const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY), [GRPC]: toCome(GRPC), [PYTORCH]: toCome(PYTORCH) } });
      const live = await pickLiveConference({ primary: PRIMARY, override: PYTORCH, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
      assert.equal(live.slug, PYTORCH);
      assert.deepEqual(s.loaded, [PRIMARY, PYTORCH]);
    });
    test('one whose talks have all ended gives no conference and a SKIP reason that names it', async () => {
      const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: toCome(PRIMARY), [MCP]: ended(MCP) } });
      const live = await pickLiveConference({ primary: PRIMARY, override: MCP, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
      assert.equal(live.slug, null);
      assert.equal(live.error, undefined);
      assert.equal(live.why, `every talk of ${MCP} has ended (SMOKE_LIVE_CONFERENCE)`);
    });
    test('one that is not a searchable conference is a configuration error', async () => {
      for (const override of [UNAVAILABLE, 'no-such-conference-2026']) {
        const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: toCome(PRIMARY) } });
        const live = await pickLiveConference({ primary: PRIMARY, override, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
        assert.equal(live.slug, null);
        assert.equal(live.error, `SMOKE_LIVE_CONFERENCE=${override} is not a searchable conference of GET /api/conferences`);
        assert.equal(live.why, live.error);
        assert.ok(!s.loaded.includes(override), 'its bundle is never read');
      }
    });
    test('one whose talks cannot be read is used', async () => {
      const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY) } });
      const live = await pickLiveConference({ primary: PRIMARY, override: GRPC, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
      assert.equal(live.slug, GRPC);
      assert.match(live.why, /^SMOKE_LIVE_CONFERENCE; its talks could not be read/);
    });
    test('naming the primary itself reads it once', async () => {
      const s = stubs({ conferences: LIST, bundles: { [PRIMARY]: ended(PRIMARY) } });
      const live = await pickLiveConference({ primary: PRIMARY, override: PRIMARY, conferences: s.conferences, loadTalks: s.loadTalks, nowMs: NOW });
      assert.equal(live.slug, null);
      assert.equal(live.why, `every talk of ${PRIMARY} has ended (SMOKE_LIVE_CONFERENCE)`);
      assert.deepEqual(s.loaded, [PRIMARY]);
    });
  });
});

describe('the For-you topics of the live conference', () => {
  const CUT = NOW + LIVE_MARGIN_MS;
  const r = (end, ...ids) => ({ end: iso(end), topics: ids.map((topic_id) => ({ topic_id, label: topic_id.toUpperCase() })) });
  const probe = (topic_id, ...results) => ({ topic_id, label: topic_id.toUpperCase(), results });

  test('rankTopics orders the probed topics by talks to come, the list order among equals, and drops those with none', () => {
    const probes = [
      probe('a', r(NOW + H, 'a'), r(NOW - H, 'a'), r(NOW - H, 'a')),
      probe('b', r(NOW + H, 'b'), r(NOW + 2 * H, 'b')),
      probe('c', r(NOW + H, 'c')),
      probe('d', r(NOW + 60_000, 'd')),
    ];
    assert.deepEqual(rankTopics(probes, CUT).map((t) => [t.topic_id, t.upcoming]), [['b', 2], ['a', 1], ['c', 1]]);
  });

  test('cooccurring pairs topics only through talks to come', () => {
    const co = cooccurring([probe('a', r(NOW + H, 'a', 'b'), r(NOW - H, 'a', 'c'))], CUT);
    assert.deepEqual([...co.get('a')], ['b']);
    assert.deepEqual([...co.get('b')], ['a']);
    assert.equal(co.has('c'), false);
  });

  test('leaveOutCase keeps the KubeCon choice while Kubernetes shares a talk to come with AI or agents', () => {
    const probes = [probe('ai', r(NOW + H, 'ai'), r(NOW + 2 * H, 'ai', 'kubernetes')), probe('kubernetes', r(NOW + 2 * H, 'ai', 'kubernetes')), probe('agents', r(NOW + H, 'agents'))];
    assert.deepEqual(leaveOutCase(probes, CUT, ['ai', 'kubernetes', 'agents', 'gpu']), { leftOut: 'kubernetes', learn: ['ai', 'agents'] });
    assert.deepEqual(PREFERRED_LEAVE_OUT, { leftOut: 'kubernetes', learn: ['ai', 'agents'] });
  });

  test('leaveOutCase takes the conference\'s own topics when the KubeCon ones share no talk to come', () => {
    // Kubernetes and AI share only an ended talk, so they would leave the check without teeth.
    const probes = [
      probe('ai', r(NOW - H, 'ai', 'kubernetes'), r(NOW + H, 'ai', 'gpu')),
      probe('kubernetes', r(NOW + H, 'kubernetes')),
      probe('agents', r(NOW + H, 'agents')),
      probe('gpu', r(NOW + H, 'ai', 'gpu'), r(NOW + 2 * H, 'gpu')),
    ];
    assert.deepEqual(leaveOutCase(probes, CUT, ['ai', 'kubernetes', 'agents', 'gpu']), { leftOut: 'gpu', learn: ['ai'] });
  });

  test('leaveOutCase on a conference without the KubeCon topics: its topic with the most talks to come that shares one, and up to two others', () => {
    const probes = [
      probe('grpc', r(NOW + H, 'grpc', 'ai'), r(NOW + H, 'grpc', 'python', 'security'), r(NOW + H, 'grpc')),
      probe('ai', r(NOW + H, 'grpc', 'ai')),
      probe('python', r(NOW + H, 'grpc', 'python', 'security')),
      probe('security', r(NOW + H, 'grpc', 'python', 'security')),
    ];
    assert.deepEqual(leaveOutCase(probes, CUT, ['grpc', 'ai', 'python', 'security']), { leftOut: 'grpc', learn: ['ai', 'python'] });
  });

  test('leaveOutCase is null when no talk to come carries two probed topics', () => {
    const probes = [probe('a', r(NOW + H, 'a'), r(NOW - H, 'a', 'b')), probe('b', r(NOW + H, 'b'))];
    assert.equal(leaveOutCase(probes, CUT, ['a', 'b']), null);
    assert.equal(leaveOutCase([], CUT, []), null);
  });

  test('whyCases builds r4\'s requests from r3\'s roles and drops those without a learn topic', () => {
    const ids = ['ai', 'kubernetes', 'agents', 'gpu', 'llm', 'ebpf', 'platform', 'security', 'storage'];
    const ranked = ['ai', 'kubernetes', 'agents', 'gpu', 'llm', 'ebpf'];
    assert.deepEqual(whyCases(ranked, ids, { leftOut: 'kubernetes', learn: ['ai', 'agents'] }), [
      [['ai', 'agents'], ['kubernetes']],
      [['kubernetes'], ['ai']],
      [['gpu', 'llm'], ['ebpf', 'kubernetes']],
      [['kubernetes', 'ai'], ['kubernetes']],
      [['ai', 'kubernetes', 'agents', 'gpu', 'llm'], ['gpu', 'llm', 'ebpf', 'platform', 'security']],
    ]);
    // One topic with talks to come and no r3 roles: the ranked topic stands in, requests without a learn topic go.
    assert.deepEqual(whyCases(['solo'], ['solo'], null), [[['solo'], []], [['solo'], ['solo']], [['solo'], []]]);
  });
});

describe('scripts/lib/smoke-report.mjs', () => {
  test('a check that throws SkipCheck prints SKIP with its reason and is never counted as a PASS', async () => {
    const lines = [];
    const { counts, check, summary } = createReporter((l) => lines.push(l));
    await check('r3: x', async () => { throw new SkipCheck('every talk of k has ended and no other searchable conference has talks to come'); });
    assert.deepEqual(lines, ['SKIP r3: x (every talk of k has ended and no other searchable conference has talks to come)']);
    assert.deepEqual(counts, { pass: 0, fail: 0, skip: 1 });
    assert.equal(summary(), 'SUMMARY 0 PASS, 0 FAIL, 1 SKIP');
  });
  test('report counts PASS and FAIL, skip counts SKIP, and any other error is a FAIL', async () => {
    const lines = [];
    const { counts, check, report, skip, summary } = createReporter((l) => lines.push(l));
    report(true, 'a', 'fine');
    report(false, 'b');
    skip('c', 'why');
    await check('d', async () => { throw new Error('boom'); });
    await check('e', async () => { report(true, 'e', 'ok'); });
    assert.deepEqual(lines, ['PASS a (fine)', 'FAIL b', 'SKIP c (why)', 'FAIL d (boom)', 'PASS e (ok)']);
    assert.deepEqual(counts, { pass: 2, fail: 2, skip: 1 });
    assert.equal(summary(), 'SUMMARY 2 PASS, 2 FAIL, 1 SKIP');
  });
});
