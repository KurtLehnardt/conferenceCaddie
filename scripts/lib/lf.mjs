// Linux Foundation event discovery: the event list, slug derivation and the schedule page config.

export const LF_LIST_URL = 'https://events.linuxfoundation.org/wp-json/lfevents/v1/events?status=upcoming';
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

// NFKD, strip combining marks, lowercase, "&" to "and", non-alphanumeric runs to "-", trim "-".
export function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const isoDate = (lfDate) => (typeof lfDate === 'string' ? lfDate.trim().replace(/\//g, '-') : '');

// Turns the raw LF list into event records with derived slugs. Throws on a slug collision or an
// invalid slug, because both would make two conferences share an identity.
export function deriveEvents(list) {
  if (!Array.isArray(list)) throw new Error('The LF event list is not a JSON array.');
  const bySlug = new Map();
  const events = [];
  for (const e of list) {
    const name = String(e.name ?? '').trim();
    const start_date = isoDate(e.date_start || e.start_date);
    const end_date = isoDate(e.date_end || e.end_date) || start_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) throw new Error(`LF event ${e.id} has no usable start date.`);
    const year = start_date.slice(0, 4);
    let slug = slugify(name);
    if (!slug.endsWith(`-${year}`)) slug = `${slug}-${year}`;
    if (!SLUG_RE.test(slug)) throw new Error(`LF event ${e.id} gives an invalid slug "${slug}".`);
    if (bySlug.has(slug)) {
      throw new Error(`Slug collision on "${slug}" between LF events ${bySlug.get(slug).lf_event_id} and ${e.id}.`);
    }
    const cta = typeof e.cta_schedule_url === 'string' ? e.cta_schedule_url.trim() : '';
    const lf_url = typeof e.url === 'string' ? e.url.trim() : '';
    const ev = {
      slug,
      name,
      start_date,
      end_date,
      location: e.location ?? null,
      lf_event_id: Number(e.id),
      lf_url,
      cta_schedule_url: cta,
      official_schedule_url: cta || lf_url,
      raw: e,
    };
    bySlug.set(slug, ev);
    events.push(ev);
  }
  return events;
}

export function locationLabel(location) {
  if (!location || location.virtual) return 'virtual';
  return [location.city, location.country].map((s) => String(s ?? '').trim()).filter(Boolean).join(', ') || 'unknown';
}

const ENTITIES = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent.toLowerCase()] ?? m;
  });
}

// Returns the parsed data-sched-config JSON of the first element that carries it, or null when
// the page has none. Throws when the attribute exists but does not parse.
export function extractSchedConfig(html) {
  const m = /data-sched-config\s*=\s*(["'])([\s\S]*?)\1/.exec(html);
  if (!m) return null;
  return JSON.parse(decodeEntities(m[2]));
}
