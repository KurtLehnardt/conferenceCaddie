// MOCK_FIXTURE_DO_NOT_SHIP
// Placeholder conferences, talks, topics and people for local development with
// VITE_MOCK=1 only. None of this is real data, every name says "Sample", and
// production builds must never contain this file.
import type { Conference, Talk, TagRef } from '../types';

export const MOCK_MARKER = 'MOCK_FIXTURE_DO_NOT_SHIP';

export interface MockTalk extends Talk {
  abstract: string;
  sponsor: boolean;
  kind: 'talk' | 'break';
}

export interface MockTopic {
  conference: string;
  topic_id: string;
  label: string;
  talk_count: number;
}

export interface MockPerson {
  ref: string;
  event_id: string;
  display_name: string;
  about: string;
  sample: boolean;
  learn_topics: string[];
  speak_topics: string[];
  shared_talk_ids: string[];
  open_to_meet: boolean;
  /** Free text the people search matches on (Find & connect). */
  expertise: string;
  interests: string;
  /** Zone-only presence of a sample person; null when they are not around. */
  presence_zone: string | null;
  presence_spot: string | null;
  /**
   * Stands in for the specificity rule: this person matches the requester only through a common
   * topic, so they are a broad match (the real server reads this from the rrf explanation).
   */
  broad_only?: boolean;
  /**
   * Turns up this long after the requester's presence goes on, in `joins_zone` or, without one,
   * the requester's own zone, so the nudge banner can be exercised; null or absent means
   * presence_zone applies as fixed.
   */
  joins_me_after_ms?: number | null;
  joins_zone?: string;
}

const A = 'sample-cloud-summit-2026';
const B = 'sample-dev-day-2026';

export const MOCK_CONFERENCES: Conference[] = [
  {
    slug: A,
    name: 'Sample Cloud Summit',
    start_date: '2026-11-09',
    end_date: '2026-11-12',
    time_zone: 'America/Chicago',
    location: { city: 'Sample City', region: '', country: 'United States', virtual: false },
    status: 'searchable',
    official_schedule_url: 'https://example.invalid/sample-cloud-summit/schedule/',
    source: 'sessionize',
    has_level: true,
    track_group: 'Track',
    tag_groups: ['Format', 'Audience'],
    talk_count: 12,
  },
  {
    slug: B,
    name: 'Sample Dev Day Nairobi',
    start_date: '2026-11-19',
    end_date: '2026-11-20',
    time_zone: 'Africa/Nairobi',
    location: { city: 'Nairobi', region: '', country: 'Kenya', virtual: false },
    status: 'searchable',
    official_schedule_url: 'https://example.invalid/sample-dev-day/schedule/',
    source: 'sessionize',
    has_level: false,
    track_group: 'Topic',
    tag_groups: ['Programme'],
    talk_count: 6,
  },
  {
    slug: 'sample-open-source-forum-2026',
    name: 'Sample Open Source Forum',
    start_date: '2026-12-07',
    end_date: '2026-12-09',
    time_zone: null,
    location: { city: 'Sample Town', region: '', country: 'Japan', virtual: false },
    status: 'unavailable',
    official_schedule_url: 'https://example.invalid/sample-open-source-forum/schedule/',
    source: 'sessionize',
    has_level: false,
    track_group: null,
    tag_groups: [],
    talk_count: 0,
  },
  {
    slug: 'sample-virtual-meetup-2027',
    name: 'Sample Virtual Meetup',
    start_date: '2027-01-20',
    end_date: '2027-01-20',
    time_zone: null,
    location: { city: '', region: '', country: '', virtual: true },
    status: 'unavailable',
    official_schedule_url: 'https://example.invalid/sample-virtual-meetup/',
    source: 'sessionize',
    has_level: false,
    track_group: null,
    tag_groups: [],
    talk_count: 0,
  },
];

const TOPIC_LABELS: Record<string, string> = {
  kubernetes: 'Kubernetes',
  ebpf: 'eBPF',
  'service-mesh': 'Service Mesh',
  security: 'Security',
  observability: 'Observability',
  ai: 'AI',
  'platform-engineering': 'Platform Engineering',
  wasm: 'WebAssembly',
  agents: 'Agents',
  'mcp-servers': 'MCP Servers',
};

function talk(
  conference: string,
  offset: string,
  n: number,
  day: string,
  start: string,
  end: string,
  extra: Partial<MockTalk> & { topicIds?: string[] },
): MockTalk {
  const { topicIds = [], ...rest } = extra;
  const id = `${conference}:${1000 + n}`;
  return {
    talk_id: id,
    conference,
    kind: 'talk',
    title: `Sample talk ${n}`,
    speakers: ['Sample Speaker One'],
    room: 'Sample Room 1',
    start: `${day}T${start}:00${offset}`,
    end: `${day}T${end}:00${offset}`,
    track: 'Sample Track 1',
    level: conference === A ? 'Beginner' : null,
    tags: [],
    topics: topicIds.map((t) => ({ topic_id: t, label: TOPIC_LABELS[t] ?? t })),
    speaker_profiles: [
      { name: 'Sample Speaker One', tagline: 'Sample tagline', links: [{ title: 'Website', url: 'https://example.invalid/speaker' }] },
    ],
    slides_url: null,
    url: `https://example.invalid/mock-session/${1000 + n}`,
    abstract: `Placeholder abstract for sample talk ${n}. It mentions kubernetes, security &amp; observability so mock searches find something.`,
    sponsor: false,
    ...rest,
  };
}

const fmt: (v: string) => TagRef = (value) => ({ group: 'Format', value });
const aud: (v: string) => TagRef = (value) => ({ group: 'Audience', value });
const prog: (v: string) => TagRef = (value) => ({ group: 'Programme', value });

// Central time in November is UTC-6; Nairobi is UTC+3 all year.
const CT = '-06:00';
const EAT = '+03:00';

export const MOCK_TALKS: MockTalk[] = [
  talk(A, CT, 1, '2026-11-09', '09:00', '09:30', {
    title: 'Sample talk 1 on Kubernetes security',
    speakers: ['Sample Speaker One', 'Sample Speaker Two'],
    tags: [fmt('Talk')],
    topicIds: ['kubernetes', 'security'],
  }),
  talk(A, CT, 2, '2026-11-09', '09:15', '09:45', {
    track: 'Sample Track 2',
    level: 'Advanced',
    room: 'Sample Room 2',
    tags: [fmt('Workshop'), aud('Operators')],
    topicIds: ['ebpf', 'observability'],
    title: 'Sample talk 2 on eBPF observability',
  }),
  talk(A, CT, 3, '2026-11-10', '10:00', '10:30', {
    track: 'Sample Track 3',
    level: 'Any Level',
    slides_url: 'https://example.invalid/mock-slides/3.pdf',
    title: 'Sample talk 3 with a deliberately long placeholder title that should clamp to two lines on a phone',
    tags: [fmt('Talk'), aud('Developers')],
    topicIds: ['service-mesh'],
  }),
  talk(A, CT, 4, '2026-11-10', '11:00', '11:30', { tags: [aud('End users')], room: null, topicIds: ['platform-engineering'] }),
  talk(A, CT, 5, '2026-11-10', '11:00', '11:45', {
    track: 'Sample Track 2',
    sponsor: true,
    level: 'Not specified',
    tags: [fmt('Demo')],
    topicIds: ['ai'],
  }),
  talk(A, CT, 6, '2026-11-10', '13:30', '14:00', { level: 'Advanced', room: 'Sample Room 3', topicIds: ['kubernetes'] }),
  talk(A, CT, 7, '2026-11-11', '14:15', '14:45', {
    track: 'Sample Track 3',
    speakers: ['Sample Speaker Three'],
    tags: [fmt('Panel')],
    topicIds: ['security', 'ai'],
  }),
  talk(A, CT, 8, '2026-11-11', '09:00', '09:30', { track: 'Sample Track 2', tags: [fmt('Lightning')], topicIds: ['wasm'] }),
  talk(A, CT, 9, '2026-11-11', '09:00', '09:45', { level: 'Any Level', room: 'Sample Room 2', topicIds: ['kubernetes', 'ebpf'] }),
  talk(A, CT, 10, '2026-11-12', '10:30', '11:00', { track: 'Sample Track 3', level: 'Advanced', topicIds: ['observability'] }),
  talk(A, CT, 11, '2026-11-12', '14:00', '14:30', { sponsor: true, track: 'Sample Track 2', topicIds: ['platform-engineering'] }),
  talk(A, CT, 12, '2026-11-12', '15:00', '15:30', { speakers: [], level: 'Beginner', room: 'Sample Room 3', topicIds: ['security'] }),
  talk(B, EAT, 21, '2026-11-19', '09:00', '09:30', {
    title: 'Sample talk 21 on MCP servers',
    track: 'Sample Topic 1',
    room: 'Sample Hall',
    tags: [prog('Keynote stage')],
    topicIds: ['mcp-servers', 'agents'],
  }),
  talk(B, EAT, 22, '2026-11-19', '10:00', '10:30', { track: 'Sample Topic 2', tags: [prog('Community')], topicIds: ['agents'] }),
  talk(B, EAT, 23, '2026-11-19', '14:00', '14:45', { track: 'Sample Topic 1', topicIds: ['mcp-servers', 'security'] }),
  talk(B, EAT, 24, '2026-11-20', '09:30', '10:00', { track: 'Sample Topic 2', tags: [prog('Community')], topicIds: ['ai'] }),
  talk(B, EAT, 25, '2026-11-20', '11:00', '11:30', { track: 'Sample Topic 1', topicIds: ['agents', 'ai'] }),
  talk(B, EAT, 26, '2026-11-20', '15:00', '15:30', { track: 'Sample Topic 2', tags: [prog('Keynote stage')], topicIds: ['security'] }),
];

export const MOCK_TOPICS: MockTopic[] = (() => {
  const out: MockTopic[] = [];
  for (const c of [A, B]) {
    const counts = new Map<string, number>();
    for (const t of MOCK_TALKS.filter((x) => x.conference === c)) {
      for (const tp of t.topics ?? []) counts.set(tp.topic_id, (counts.get(tp.topic_id) ?? 0) + 1);
    }
    for (const [topic_id, talk_count] of counts) {
      out.push({ conference: c, topic_id, label: TOPIC_LABELS[topic_id] ?? topic_id, talk_count });
    }
  }
  return out.sort((a, b) => b.talk_count - a.talk_count);
})();

/** How long after my presence goes on the nudge fixture person turns up in my zone. */
const NUDGE_JOIN_MS = 8_000;
/** How long after my presence goes on the watched fixture person turns up, in another zone. */
const WATCH_JOIN_MS = 12_000;

function person(
  n: number,
  event_id: string,
  name: string,
  learn: string[],
  speak: string[],
  shared: string[],
  open_to_meet = true,
  text: {
    expertise?: string;
    interests?: string;
    zone?: string | null;
    spot?: string | null;
    broad_only?: boolean;
    joins_me_after_ms?: number | null;
    joins_zone?: string;
  } = {},
): MockPerson {
  return {
    ref: `mockref${String(n).padStart(9, '0')}`,
    event_id,
    display_name: `Sample · ${name}`,
    about: `Placeholder profile ${n} for local development.`,
    sample: true,
    learn_topics: learn,
    speak_topics: speak,
    shared_talk_ids: shared,
    open_to_meet,
    expertise: text.expertise ?? `Placeholder experience ${n}: ran sample clusters and wrote sample tooling.`,
    interests: text.interests ?? `Placeholder interest ${n}: comparing notes on sample platforms.`,
    presence_zone: text.zone ?? null,
    presence_spot: text.spot ?? null,
    ...(text.broad_only ? { broad_only: true } : {}),
    ...(text.joins_me_after_ms !== undefined ? { joins_me_after_ms: text.joins_me_after_ms } : {}),
    ...(text.joins_zone ? { joins_zone: text.joins_zone } : {}),
  };
}

// Extra sample people so the people search has more than one page of 20.
const FILLER_EXPERTISE = [
  'Ran Postgres operators on bare metal for 3 years and lived through two storage migrations.',
  'Moved a 40-team platform to GitOps with Argo CD; wrote the rollback runbooks.',
  'Built an internal developer portal on Backstage and then replaced half of it.',
  'Tuned eBPF probes in production until the overhead fell under one percent.',
  'Operated a multi-cluster service mesh across three clouds with mTLS everywhere.',
  'Wrote admission policies in Rego and then migrated them to Kyverno.',
  'Scaled a Kafka platform past a million messages a second on Kubernetes.',
  'Shipped WebAssembly plugins for an API gateway and measured cold starts.',
  'Set up GPU scheduling for an ML platform; fought the node autoscaler and won.',
  'Debugged DNS in Kubernetes more times than anyone should.',
  'Migrated CI from Jenkins to Tekton for a 200-developer org.',
  'Built cost dashboards from OpenCost and cut the cloud bill by a third.',
  'Ran an on-call rotation for a managed Kubernetes product with 400 clusters.',
];

const FILLER_NAMES = [
  'Harper', 'Indigo', 'Jules', 'Kai', 'Lennon', 'Marlowe', 'Noor', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum',
  'Uma', 'Vesper', 'Wren', 'Xen', 'Yael', 'Zephyr', 'Arden', 'Bellamy', 'Cleo', 'Dakota', 'Ellis', 'Frankie', 'Greer',
];
const FILLER_TOPICS = ['kubernetes', 'ebpf', 'service-mesh', 'security', 'observability', 'ai', 'platform-engineering', 'wasm'];

const FIXED_ZONE_SAMPLES = ['Hallway', 'Food and coffee', 'Sample Room 2', 'Registration', 'Outside', 'Expo hall'];

const FILLER: MockPerson[] = FILLER_NAMES.map((name, i) =>
  person(
    100 + i,
    A,
    name,
    [FILLER_TOPICS[(i + 3) % FILLER_TOPICS.length]],
    [FILLER_TOPICS[i % FILLER_TOPICS.length]],
    [],
    true,
    {
      expertise: FILLER_EXPERTISE[i % FILLER_EXPERTISE.length],
      zone: i % 5 === 0 ? FIXED_ZONE_SAMPLES[(i / 5) % FIXED_ZONE_SAMPLES.length] : null,
    },
  ),
);

export const MOCK_PEOPLE: MockPerson[] = [
  person(1, A, 'Avery', ['ebpf'], ['kubernetes', 'security'], [`${A}:1001`], true, {
    expertise: 'Ran Postgres operators on bare metal for 3 years; broke and fixed Kubernetes upgrades across 60 clusters.',
    interests: 'Getting Postgres failover under a minute without a managed service.',
    zone: 'Sample Room 1',
    spot: 'back row, left',
  }),
  person(2, A, 'Blake', ['security'], ['ebpf', 'observability'], [`${A}:1001`, `${A}:1003`], true, {
    expertise: 'Tuned eBPF probes in production until the overhead fell under one percent; built the tracing pipeline around them.',
    interests: 'Supply-chain security for a platform team that ships 300 images a day.',
    zone: 'Expo hall',
    spot: 'by the coffee cart',
  }),
  person(3, A, 'Casey', ['ai'], ['service-mesh'], [`${A}:1003`], true, {
    expertise: 'Operated a multi-cluster service mesh across three clouds; wrote the mTLS rotation tooling.',
    interests: 'Running inference workloads next to the mesh without doubling latency.',
  }),
  // Devon is never around: the card offers "Tell me when they're around" instead of an ask.
  person(4, A, 'Devon', ['kubernetes'], ['platform-engineering'], [], true, {
    expertise: 'Moved a 40-team platform to GitOps with Argo CD; wrote the rollback runbooks.',
    interests: 'Kubernetes multi-tenancy for teams that refuse to share a cluster.',
  }),
  // Hollis is in the Expo hall, the zone the drive turns presence on in, so a card shows "Wave".
  person(8, A, 'Hollis', ['wasm'], ['kubernetes'], [], true, {
    expertise: 'Scaled a Kafka platform past a million messages a second on Kubernetes; wrote the partition rebalancing runbook.',
    interests: 'Running stateful workloads without a storage team.',
    zone: 'Expo hall',
    spot: 'tall, by the espresso machine',
  }),
  person(5, A, 'Emery', ['observability'], ['wasm'], [`${A}:1001`], false, {
    expertise: 'Shipped WebAssembly plugins for an API gateway and measured cold starts.',
  }),
  person(6, B, 'Finley', ['agents'], ['mcp-servers'], [`${B}:1021`], true, {
    expertise: 'Wrote three MCP servers for internal tools and hardened them after a prompt-injection incident.',
    interests: 'Evaluating agents without an eval team.',
    zone: 'Sample Hall',
  }),
  person(7, B, 'Gray', ['mcp-servers'], ['ai', 'agents'], [`${B}:1021`], true, {
    expertise: 'Built an agent platform on top of a message queue; learned why retries and tool calls do not mix.',
    interests: 'Securing MCP servers that other teams write.',
  }),
  // Nudges: a specific match who walks into my zone about 8 s after I turn presence on.
  person(11, A, 'Rowan', ['observability'], ['kubernetes', 'platform-engineering'], [], true, {
    expertise: "Rebuilt a 3,000-node cluster's etcd from a snapshot during a live event. Wrote the runbook afterwards.",
    interests: 'Making control-plane recovery boring.',
    joins_me_after_ms: NUDGE_JOIN_MS,
  }),
  // Nudges: a broad match (common topic only) who is in my zone from the start and must never nudge.
  person(9, A, 'Sawyer', ['security'], ['kubernetes'], [], true, {
    expertise: 'Keeps a few clusters running for a small team.',
    interests: 'Whatever everyone else is talking about this year.',
    broad_only: true,
    joins_me_after_ms: 0,
  }),
  // Nudges: someone to watch (caddie.watch.v1) who turns up in another zone ~12 s after I'm around.
  person(10, A, 'Tenzin', ['wasm'], ['observability'], [], true, {
    expertise: 'Ran the tracing backend for a payments company; cut cardinality by 90% without losing an alert.',
    interests: 'Profiling in production without a sidecar per pod.',
    joins_me_after_ms: WATCH_JOIN_MS,
    joins_zone: 'Hallway',
  }),
  ...FILLER,
];

/** The sample person who asks the user to talk shop shortly after presence is turned on. */
export const MOCK_REQUESTER_REF = 'mockref000000002';
