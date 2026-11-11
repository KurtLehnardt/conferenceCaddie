// The reason lines of a person result (reasonsFor in server/people.mjs; cor-6 in
// REVIEW_NOTES_FREE.md): a reason that ends in an inserted talk title, passage or evidence is
// closed with a period only when that text does not already end a sentence, so a title such as
// "... Here's What the Data Says." gives one period, not "..", and one ending in "?", "!" or an
// ellipsis gets none. The same rule as reasonsFor in worker/src/people/view.js.
//
// Run with `npm test`. Nothing reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './lib/fake-es.mjs';

const { reasonsFor } = await import('../server/people.mjs');

const ME = { speak_topics: [], learn_topics: [], shared_talk_ids: [] };
const NO_LABELS = new Map();
const T1 = 'testconf-2099:1';
const T2 = 'testconf-2099:2';

// The "You are both interested in" reason for one shared talk with this title.
const sharedTalk = (title) => reasonsFor(ME, { ...ME, shared_talk_ids: [T1] }, NO_LABELS, new Map([[T1, title]]), null, null);
// The circle reason (the talk the circle is about) for a talk with this title.
const circleTalk = (title) => reasonsFor(ME, ME, NO_LABELS, new Map([[T1, title]]), null, T1);

test('a title that ends a sentence is not given a second period', () => {
  const cases = [
    ['Observability at Scale: Here\'s What the Data Says.', 'You are both interested in Observability at Scale: Here\'s What the Data Says.'],
    ['Do We Still Need Sidecars?', 'You are both interested in Do We Still Need Sidecars?'],
    ['Ship It!', 'You are both interested in Ship It!'],
    ['Kubernetes, Agents and More…', 'You are both interested in Kubernetes, Agents and More…'],
    ['Wait, What?!', 'You are both interested in Wait, What?!'],
    ['They Said "It Works."', 'You are both interested in They Said "It Works."'],
    ['Edge Inference (Really!)', 'You are both interested in Edge Inference (Really!)'],
    ['Why Not?”', 'You are both interested in Why Not?”'],
    ['Done. ', 'You are both interested in Done.'],
  ];
  for (const [title, reason] of cases) {
    assert.deepEqual(sharedTalk(title), [reason], title);
    assert.deepEqual(circleTalk(title), [reason], title);
  }
});

test('a title that does not end a sentence still gets its period', () => {
  for (const title of ['Kubernetes for Beginners', 'Scaling etcd: Lessons Learned', 'What Comes After v1.0', 'Version 2.x', 'Ellipsis in the Middle… of a Title']) {
    assert.deepEqual(sharedTalk(title), [`You are both interested in ${title}.`], title);
  }
});

test('with two shared talks the last title decides', () => {
  const titles = new Map([[T1, 'Is This the End?'], [T2, 'Platform Engineering 101']]);
  assert.deepEqual(reasonsFor(ME, { ...ME, shared_talk_ids: [T1, T2] }, NO_LABELS, titles, null, null), ['You are both interested in Is This the End? and Platform Engineering 101.']);
  const reversed = new Map([[T1, 'Platform Engineering 101'], [T2, 'Is This the End?']]);
  assert.deepEqual(reasonsFor(ME, { ...ME, shared_talk_ids: [T1, T2] }, NO_LABELS, reversed, null, null), ['You are both interested in Platform Engineering 101 and Is This the End?']);
});

test('a passage or evidence cut with an ellipsis gets no period after it', () => {
  const long = `${'Running Kubernetes operators for stateful databases in production '.repeat(5)}end`;
  const [evidence] = reasonsFor(ME, ME, NO_LABELS, new Map(), null, null, { evidence: long });
  assert.match(evidence, /^They've worked on Running Kubernetes operators/);
  assert.ok(evidence.endsWith('…'), evidence);
  const [ask] = reasonsFor(ME, ME, NO_LABELS, new Map(), 'eBPF tracing and what comes after…', null);
  assert.equal(ask, 'Ask them about eBPF tracing and what comes after…');
  assert.deepEqual(reasonsFor(ME, ME, NO_LABELS, new Map(), 'eBPF tracing', null), ['Ask them about eBPF tracing.']);
  assert.deepEqual(reasonsFor(ME, ME, NO_LABELS, new Map(), null, null, { evidence: '<mark>Kubernetes</mark> operators.' }), ['They\'ve worked on Kubernetes operators.']);
});

test('no reason ends in "..", "?.", "!." or an ellipsis and a period', () => {
  const titles = ['A.', 'B?', 'C!', 'D…', 'E', 'F..."', 'G?)'];
  for (const title of titles) {
    for (const reason of [...sharedTalk(title), ...circleTalk(title)]) assert.doesNotMatch(reason, /(\.\.|\?\.|!\.|…\.)$/, reason);
  }
  const zone = reasonsFor(ME, ME, NO_LABELS, new Map(), null, null, { zone: 'Hall B' });
  assert.deepEqual(zone, ['They\'re in Hall B right now.']);
});
