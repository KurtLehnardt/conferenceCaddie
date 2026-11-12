// Generates data/samples/dummy-people.json: 100 labelled sample profiles for the KubeCon demo.
//
// Usage: node scripts/make-dummy-people.mjs [--event <slug>] [--out <path>]
// Env:   ES_API_KEY (or ELASTISEARCH_API_KEY) to search the talks index; ES_URL; ES_INDEX;
//        APP_URL or CADDIE_APP_URL for the topic list (required: the app's address, no default).
//
// Everything except the shared talks is deterministic: names, topics and texts come from fixed lists
// and a seeded shuffle, so a re-run writes the same profiles. The shared talks come from Elasticsearch
// (talks of the conference, kind talk, not yet ended). Their tie-break uses a fixed random_score seed
// per profile, so they stay the same as long as the index and the clock allow.
//
// Topics. Every profile gets exactly 10 learn topics and 10 speak topics, and the two sets never
// overlap. The topic list is walked in passes, each pass in a differently shuffled order, and the
// stream is cut into sets of ten. Every topic therefore appears in the learn sets as nearly equally
// often as possible (the counts differ by at most one), and the same holds for the speak sets.
// A repair step swaps topics between sets so that no set holds a topic twice and no profile learns
// and speaks the same topic; swaps keep the counts unchanged.
//
// Shared talks. For each profile one Elasticsearch query ranks the upcoming talks by how many of the
// profile's learn topics they carry, with a seeded random tie-break. Profile i takes results
// 10 * (i mod 5) + 1 to 10 * (i mod 5) + 10 of the top 50, which spreads the circles across many
// talks instead of piling every profile onto the same top hits. If the window holds fewer than ten,
// the profile is filled from its other learn matches and then from a query on its speak topics.
//
// The output is read by scripts/seed-people.mjs with --label dummy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { esUrlOrExit } from './lib/es-url.mjs';
const KEY = process.env.ES_API_KEY || process.env.ELASTISEARCH_API_KEY;
const TALKS_INDEX = process.env.ES_INDEX || 'caddie-talks';
const APP_URL = (process.env.APP_URL || process.env.CADDIE_APP_URL || '').replace(/\/$/, '');
if (!APP_URL) {
  console.error('Set APP_URL or CADDIE_APP_URL to the app address (for example https://caddie.example.workers.dev).');
  process.exit(1);
}
const COUNT = 100;
const SET_SIZE = 10;
const SHARED = 10;
const LINKEDIN = 'https://linkedin.com/in/kurtlehnardt';
const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

const args = process.argv.slice(2);
let slug = 'kubecon-cloudnativecon-north-america-2026';
let outArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event') slug = args[++i];
  else if (args[i] === '--out') outArg = args[++i];
  else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!KEY) {
  console.error('Set ES_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}
if (!LINKEDIN_RE.test(LINKEDIN)) {
  console.error('The LinkedIn address does not pass the server pattern; stopping.');
  process.exit(1);
}
const outFile = outArg ? path.resolve(outArg) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'samples', 'dummy-people.json');

// Names: ten regions, ten first names and ten last names each. Profile i takes region i mod 10 and
// the first name number floor(i / 10) of that region; the last name is a fixed permutation of the
// region's ten, so all 100 full names are distinct.
const REGIONS = [
  ['Aarav Ananya Rohan Meera Vikram Kavya Arjun Nisha Rahul Divya', 'Iyer Menon Kulkarni Banerjee Chandra Desai Nair Rao Bhatt Kapoor'],
  ['Haruto Mei Jun Soo-jin Kenji Yuna Wei Lin Hyun-woo Aiko', 'Tanaka Park Chen Nakamura Lim Huang Yamada Choi Wu Sato'],
  ['Mateo Valentina Santiago Camila Joaquín Lucía Diego Renata Thiago Ximena', 'Herrera Castillo Ferreira Morales Ortega Vargas Rojas Mendoza Navarro Salazar'],
  ['Omar Layla Karim Salma Youssef Noor Tariq Leila Hassan Dina', 'Haddad Nasser Farouk Khalil Mansour Rahimi Bennani Saleh Aziz Darwish'],
  ['Kwame Amara Tunde Zuri Sipho Folake Kofi Nia Chidi Thandi', 'Okafor Mensah Adeyemi Dlamini Nkosi Boateng Abara Kamau Mwangi Osei'],
  ['Lukas Élodie Matteo Ingrid Jonas Chiara Pieter Margaux Stefan Anneke', 'Müller Rossi Dubois Bergström Janssen Fontaine Keller Lindqvist Moretti Brandt'],
  ['Tomasz Katarina Dmitri Ioana Marek Zofia Andrei Nadia Bogdan Elena', 'Novak Kowalski Petrov Popescu Horvat Volkov Dvorak Ilic Marinescu Kovacs'],
  ['Marcus Hannah Connor Olivia Ethan Chloe Declan Imogen Tyler Emily', 'Brooks Whitfield Calloway Sullivan Hargrove Prescott Donovan Ellison Fitzgerald Rowan'],
  ['Budi Linh Arif Mai Joel Siti Minh Aroha Kalani Dewi', 'Santoso Tran Rahman Pham Reyes Hakim Wijaya Aguilar Tupou Lestari'],
  ['Andre Jasmine Malik Keisha Dante Simone Ravi Tamsin Giovanni Soraya', 'Beaumont Campbell Francis Lacroix Pierre Gordon Cassidy Ramdin Isaacs Benoit'],
].map(([f, l]) => [f.split(' '), l.split(' ')]);

function nameFor(i) {
  const region = i % 10;
  const k = Math.floor(i / 10);
  const [first, last] = REGIONS[region];
  return `${first[k]} ${last[(k * 3 + region) % 10]}`;
}

const ROLES = [
  'Platform engineer', 'Site reliability engineer', 'Security engineer', 'Developer advocate', 'Staff engineer',
  'Engineering manager', 'Open source maintainer', 'Solutions architect', 'Machine learning engineer', 'Infrastructure lead',
];
const ABOUT = [
  (r, a, b) => `${r} working on ${a} and ${b}`,
  (r, a, b) => `${r} focused on ${a}, with plenty of ${b} in production`,
  (r, a, b) => `${r} who spends most days on ${a} and ${b}`,
  (r, a, b) => `${r} building ${a} and ${b} for a large team`,
];

const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);

// A small seeded generator, so the shuffles never change between runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(items, rand) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A stream of COUNT * SET_SIZE topic indexes, in passes over all topics, each pass shuffled
// differently, cut into COUNT sets of SET_SIZE.
function stream(topicCount, seed) {
  const rand = mulberry32(seed);
  const out = [];
  while (out.length < COUNT * SET_SIZE) {
    out.push(...shuffled([...Array(topicCount).keys()], rand));
  }
  out.length = COUNT * SET_SIZE;
  return Array.from({ length: COUNT }, (_, i) => out.slice(i * SET_SIZE, (i + 1) * SET_SIZE));
}

function balanceSets(topicCount) {
  const learn = stream(topicCount, 20261109);
  const speak = stream(topicCount, 20261112);
  const has = (set, x, skip = -1) => set.some((v, p) => p !== skip && v === x);
  // Learn sets: no repeated topic inside a set.
  for (let i = 0; i < COUNT; i++) {
    for (let p = 0; p < SET_SIZE; p++) {
      if (!has(learn[i], learn[i][p], p)) continue;
      let fixed = false;
      for (let step = 1; step < COUNT && !fixed; step++) {
        const j = (i + step) % COUNT;
        for (let q = 0; q < SET_SIZE && !fixed; q++) {
          const x = learn[i][p];
          const y = learn[j][q];
          if (!has(learn[i], y) && !has(learn[j], x, q)) {
            learn[i][p] = y;
            learn[j][q] = x;
            fixed = true;
          }
        }
      }
      if (!fixed) throw new Error('Could not repair a learn set.');
    }
  }
  // Speak sets: no repeated topic inside a set, and none shared with the same profile's learn set.
  const bad = (i, x, p) => has(speak[i], x, p) || has(learn[i], x);
  for (let i = 0; i < COUNT; i++) {
    for (let p = 0; p < SET_SIZE; p++) {
      if (!bad(i, speak[i][p], p)) continue;
      let fixed = false;
      for (let step = 1; step < COUNT && !fixed; step++) {
        const j = (i + step) % COUNT;
        for (let q = 0; q < SET_SIZE && !fixed; q++) {
          const x = speak[i][p];
          const y = speak[j][q];
          if (!bad(i, y, -1) && !has(speak[j], x, q) && !has(learn[j], x)) {
            speak[i][p] = y;
            speak[j][q] = x;
            fixed = true;
          }
        }
      }
      if (!fixed) throw new Error('Could not repair a speak set.');
    }
  }
  return { learn, speak };
}

async function search(body) {
  const res = await fetch(`${esUrlOrExit()}/${TALKS_INDEX}/_search`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Talk search failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return (json.hits?.hits ?? []).map((h) => h._source.talk_id);
}

// Upcoming talks ranked by overlap with the topics, with a seeded tie-break that differs per profile.
function talkQuery(topicIds, seed) {
  return {
    size: 50,
    _source: ['talk_id'],
    query: {
      function_score: {
        query: {
          bool: {
            filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }, { range: { end: { gt: 'now' } } }],
            should: topicIds.map((t) => ({ constant_score: { filter: { term: { topics: t } }, boost: 1 } })),
            minimum_should_match: 1,
          },
        },
        functions: [{ random_score: { seed, field: '_seq_no' }, weight: 0.9 }],
        score_mode: 'sum',
        boost_mode: 'sum',
      },
    },
  };
}

// The topic list of the live service.
const topicRes = await fetch(`${APP_URL}/api/topics?event=${encodeURIComponent(slug)}&size=150`, { signal: AbortSignal.timeout(30_000) });
if (!topicRes.ok) {
  console.error(`Topic list failed with status ${topicRes.status}.`);
  process.exit(1);
}
const topics = (await topicRes.json()).topics.map((t) => ({ topic_id: t.topic_id, label: t.label }));
if (topics.length < SET_SIZE * 2) {
  console.error('Too few topics to build disjoint learn and speak sets.');
  process.exit(1);
}

const { learn, speak } = balanceSets(topics.length);
const profiles = [];
const sharers = new Map();
for (let i = 0; i < COUNT; i++) {
  const learnIds = learn[i].map((x) => topics[x].topic_id);
  const speakIds = speak[i].map((x) => topics[x].topic_id);
  const learnLabels = learn[i].map((x) => topics[x].label);
  const speakLabels = speak[i].map((x) => topics[x].label);

  // Shared talks.
  const ranked = await search(talkQuery(learnIds, i + 1));
  const offset = (i % 5) * SHARED;
  const chosen = ranked.slice(offset, offset + SHARED);
  for (const id of ranked) {
    if (chosen.length >= SHARED) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  if (chosen.length < SHARED) {
    for (const id of await search(talkQuery(speakIds, i + 1001))) {
      if (chosen.length >= SHARED) break;
      if (!chosen.includes(id)) chosen.push(id);
    }
  }
  if (chosen.length < SHARED) {
    console.error(`Profile ${i} found only ${chosen.length} upcoming talks; stopping.`);
    process.exit(1);
  }
  for (const id of chosen) sharers.set(id, (sharers.get(id) ?? 0) + 1);

  const name = `Sample · ${nameFor(i)}`;
  const about = ABOUT[i % 4](ROLES[(i * 7 + 3) % ROLES.length], speakLabels[0], speakLabels[1]);
  const interests = `I want to learn more about ${list(learnLabels.slice(0, 5))}. I am also looking into ${list(learnLabels.slice(5))}.`;
  const expertise = `I can talk about ${list(speakLabels.slice(0, 5))}. I also have hands-on experience with ${list(speakLabels.slice(5))}.`;
  if (name.length > 60 || about.length > 280 || interests.length > 500 || expertise.length > 500) {
    throw new Error(`Profile ${i} exceeds a length cap.`);
  }
  profiles.push({
    display_name: name,
    about,
    interests,
    expertise,
    learn: learnLabels,
    speak: speakLabels,
    learn_ids: learnIds,
    speak_ids: speakIds,
    linkedin_url: LINKEDIN,
    contact_note: 'Sample profile for the demo',
    open_to_meet: true,
    shared_talk_ids: chosen,
  });
}

// Checks.
const names = new Set(profiles.map((p) => p.display_name));
if (names.size !== COUNT) throw new Error('Names are not distinct.');
const count = (key) => {
  const m = new Map(topics.map((t) => [t.topic_id, 0]));
  for (const p of profiles) for (const id of p[key]) m.set(id, m.get(id) + 1);
  return [...m.values()];
};
const lc = count('learn_ids');
const sc = count('speak_ids');
for (const p of profiles) {
  if (new Set(p.learn_ids).size !== SET_SIZE || new Set(p.speak_ids).size !== SET_SIZE) throw new Error('A set is not ten distinct topics.');
  if (p.learn_ids.some((id) => p.speak_ids.includes(id))) throw new Error('A profile learns and speaks the same topic.');
}
if (Math.max(...lc) - Math.min(...lc) > 1 || Math.max(...sc) - Math.min(...sc) > 1) throw new Error('Topic counts are not even.');
if (lc.some((n) => n === 0) || sc.some((n) => n === 0)) throw new Error('A topic is never learned or never spoken.');

const perTalk = [...sharers.values()].sort((a, b) => a - b);
const median = (perTalk[Math.floor((perTalk.length - 1) / 2)] + perTalk[Math.ceil((perTalk.length - 1) / 2)]) / 2;

const note = `${COUNT} invented sample profiles for the demo of ${slug}. None is a real person. Every profile learns ${SET_SIZE} topics and speaks to ${SET_SIZE} others, spread evenly over the conference's ${topics.length} topics, and shares for ${SHARED} upcoming talks chosen by Elasticsearch. All link to ${LINKEDIN} by the owner's choice. Written by scripts/make-dummy-people.mjs; seed with: node scripts/seed-people.mjs --event ${slug} --file data/samples/dummy-people.json --label dummy`;
fs.writeFileSync(outFile, JSON.stringify({ note, event: slug, profiles }, null, 2) + '\n');

console.log(`Wrote ${profiles.length} profiles to ${path.relative(process.cwd(), outFile)}.`);
console.log(`Topics: ${topics.length}. Learn counts per topic: min ${Math.min(...lc)}, max ${Math.max(...lc)}. Speak counts: min ${Math.min(...sc)}, max ${Math.max(...sc)}.`);
console.log(`Shared talks: ${perTalk.length} distinct; sharers per talk: min ${perTalk[0]}, max ${perTalk[perTalk.length - 1]}, median ${median}.`);
