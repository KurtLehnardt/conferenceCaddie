// Turns a Sessionize view/All feed plus the schedule page config into talk documents.
// Every group, question and track name comes from the feed or the config; nothing is specific
// to one conference.
import { makeLocalTime } from './zones.mjs';
import { textHash, contentHash } from './hash.mjs';

const NOT_SPECIFIED = 'Not specified';
const fold = (s) => String(s ?? '').trim().toLowerCase();
const bySort = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (a.id ?? 0) - (b.id ?? 0);

// Decides the role of each category group.
//   track:  the group titled like primaryFilterTitle, else the non-hidden group with the lowest sort.
//   hidden: groups named in hiddenFilterCategories (case-insensitive). No tags or facets, but still
//           read for sponsor detection.
//   level:  the first remaining group whose title contains "level"; none means no level filter.
//   tags:   every other group, in feed sort order.
export function categoryMapping(feed, config) {
  const groups = [...(feed.categories ?? [])].sort(bySort);
  const hiddenNames = new Set((config.hiddenFilterCategories ?? []).map(fold));
  const hidden = groups.filter((g) => hiddenNames.has(fold(g.title)));
  const primary = fold(config.primaryFilterTitle);
  const track = (primary && groups.find((g) => fold(g.title) === primary)) || groups.find((g) => !hidden.includes(g)) || null;
  const rest = groups.filter((g) => g !== track && !hidden.includes(g));
  const level = rest.find((g) => /level/i.test(g.title)) ?? null;
  const tagGroups = rest.filter((g) => g !== level);

  const wanted = fold(config.presentationSlidesQuestionId);
  const slidesQuestion = wanted ? (feed.questions ?? []).find((q) => fold(q.question) === wanted) ?? null : null;

  return {
    groups: { track, level, hidden, tagGroups },
    slidesQuestion,
    public: {
      track_group: track ? track.title.trim() : null,
      level_group: level ? level.title.trim() : null,
      tag_groups: tagGroups.map((g) => g.title.trim()),
      hidden_groups: hidden.map((g) => g.title.trim()),
      slides_question: slidesQuestion ? slidesQuestion.question.trim() : null,
    },
  };
}

// kind rules, first match wins:
//   1. housekeeping: no description and the title reads as an opening, closing, welcome, remarks or wrap-up.
//   2. break: no speakers, and the title (before any " | ") is coffee, lunch, breakfast, registration, badge,
//      coat or bag check, snacks or a reception, or the track name mentions breaks or registration.
//   3. talk: at least one speaker.
//   4. ambient: no speakers and nothing above matched, for example a keynote whose speaker is not announced.
const HOUSEKEEPING_TITLE = /(^|\s)(opening|closing)(\s*\/\s*intro)?(\s+remarks)?\s*$|\bremarks\b|\bwrap-?up\b|^welcome\b|\bwelcome back\b/i;
const BREAK_TITLE = /\b(coffee|lunch|breakfast|registration|badge|coat|bag check|snacks?|receptions?)\b/i;
const BREAK_TRACK = /\b(breaks?|registration)\b/i;
function kindOf(title, description, speakerCount, track) {
  const head = title.split(' | ')[0];
  if (!description && HOUSEKEEPING_TITLE.test(title)) return 'housekeeping';
  if (speakerCount === 0 && (BREAK_TITLE.test(head) || BREAK_TRACK.test(track))) return 'break';
  if (speakerCount > 0) return 'talk';
  return 'ambient';
}

// Sponsor content: any category item (hidden groups included) whose item or group name mentions
// "sponsor", a track name that mentions it, or a title that says "sponsored by", "sponsored keynote"
// or "in-booth demos". Descriptions are not used because many carry boilerplate about sponsors.
const SPONSOR_TITLE = /\bsponsored (by|keynote)\b|\bin-booth demos?\b/i;
const SPONSOR_WORD = /sponsor/i;

const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s.trim());

// conf: { slug, time_zone, sessionize_public_slug, sessionize_site_published, official_schedule_url }
// Returns { docs, counts, mapping, unresolved }. unresolved lists names that could not be resolved;
// a caller must treat any as fatal.
export function buildTalks(feed, config, conf) {
  const mapping = categoryMapping(feed, config);
  const { track: trackGroup, level: levelGroup, tagGroups } = mapping.groups;
  const role = new Map();
  for (const g of feed.categories ?? []) {
    const r = g === trackGroup ? 'track' : g === levelGroup ? 'level' : tagGroups.includes(g) ? 'tag' : 'hidden';
    for (const item of g.items ?? []) {
      role.set(item.id, { role: r, group: g, name: String(item.name).trim(), sort: item.sort ?? 0 });
    }
  }

  const rooms = new Map((feed.rooms ?? []).map((r) => [r.id, String(r.name).trim()]));
  const speakers = new Map(
    (feed.speakers ?? []).map((s) => [
      s.id,
      {
        name: String(s.fullName || `${s.firstName ?? ''} ${s.lastName ?? ''}`).trim(),
        tagline: typeof s.tagLine === 'string' && s.tagLine.trim() ? s.tagLine.trim() : null,
        links: (s.links ?? [])
          .filter((l) => isHttp(l.url))
          .map((l) => ({ title: String(l.title || l.linkType || 'Link').trim(), url: l.url.trim() })),
      },
    ])
  );

  const withOffset = makeLocalTime(conf.time_zone);
  const counts = { sessions: 0, talk: 0, ambient: 0, break: 0, housekeeping: 0, with_slides: 0, sponsor: 0 };
  const unresolved = [];
  const docs = [];

  for (const s of feed.sessions ?? []) {
    const title = String(s.title ?? '').trim();
    const abstract = String(s.description ?? '').replace(/\r\n?/g, '\n').trim();

    const names = [];
    const taglines = [];
    const profiles = [];
    for (const id of s.speakers ?? []) {
      const sp = speakers.get(id);
      if (!sp) { unresolved.push(`speaker ${id} in session ${s.id}`); continue; }
      names.push(sp.name);
      if (sp.tagline) taglines.push(sp.tagline);
      profiles.push({ name: sp.name, tagline: sp.tagline, links: sp.links });
    }

    let room = null;
    if (s.roomId != null) {
      room = rooms.get(s.roomId) ?? null;
      if (room === null) unresolved.push(`room ${s.roomId} in session ${s.id}`);
    }

    const items = [];
    for (const id of s.categoryItems ?? []) {
      const it = role.get(id);
      if (!it) { unresolved.push(`category item ${id} in session ${s.id}`); continue; }
      items.push(it);
    }
    const firstIn = (r) => items.filter((it) => it.role === r).sort((a, b) => a.sort - b.sort)[0]?.name;
    const track = firstIn('track') ?? NOT_SPECIFIED;
    const level = levelGroup ? firstIn('level') ?? NOT_SPECIFIED : null;
    const tags = items
      .filter((it) => it.role === 'tag')
      .sort((a, b) => bySort(a.group, b.group) || a.sort - b.sort)
      .map((it) => ({ group: it.group.title.trim(), value: it.name }));

    let slides_url = null;
    if (mapping.slidesQuestion) {
      const answer = (s.questionAnswers ?? []).find((a) => a.questionId === mapping.slidesQuestion.id);
      if (answer && isHttp(answer.answerValue)) slides_url = answer.answerValue.trim();
    }

    const sponsor =
      items.some((it) => SPONSOR_WORD.test(it.name) || SPONSOR_WORD.test(it.group.title)) ||
      SPONSOR_WORD.test(track) ||
      SPONSOR_TITLE.test(title);

    const start = withOffset(s.startsAt);
    const end = withOffset(s.endsAt);
    const kind = kindOf(title, abstract, names.length, track);
    const sessionId = String(s.id);

    const doc = {
      talk_id: `${conf.slug}:${sessionId}`,
      conference: conf.slug,
      session_id: sessionId,
      kind,
      title,
      abstract,
      speakers: names,
      speaker_taglines: taglines,
      speaker_profiles: profiles,
      room,
      track,
      level,
      tags,
      tag_keys: tags.map((t) => `${t.group}\u001f${t.value}`),
      sponsor,
      has_slides: slides_url !== null,
      slides_url,
      url: conf.sessionize_site_published
        ? `https://${conf.sessionize_public_slug}.sessionize.com/session/${sessionId}`
        : conf.official_schedule_url,
      start: start.iso,
      end: end.iso,
      day: start.day,
      start_minutes: start.minutes,
      end_minutes: end.day === start.day ? end.minutes : end.minutes + 1440,
    };
    doc.text_hash = textHash(doc);
    doc.content_hash = contentHash(doc);
    docs.push(doc);

    counts.sessions++;
    counts[kind]++;
    if (doc.has_slides) counts.with_slides++;
    if (sponsor) counts.sponsor++;
  }

  return { docs, counts, mapping: mapping.public, unresolved };
}
