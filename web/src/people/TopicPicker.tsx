// Topic picker for one chip set. Not a modal: selected chips are pinned on top,
// then type-ahead results, "Suggested for you", and the most common topics with
// "Show more". One tap adds a topic and one tap removes it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Plus, Search, X } from 'lucide-preact';
import { fetchTopics, isAbort, suggestTopics } from './api';
import type { TopicHit, TopicRef } from './types';

const MAX_TOPICS = 30;
const FIRST = 12;

const topCache = new Map<string, Promise<TopicHit[]>>();

function topTopics(slug: string): Promise<TopicHit[]> {
  let p = topCache.get(slug);
  if (!p) {
    p = fetchTopics(slug, '', 150).then((r) => r.topics ?? []);
    p.catch(() => topCache.delete(slug));
    topCache.set(slug, p);
  }
  return p;
}

function Chip({
  topic,
  on,
  disabled,
  onToggle,
}: {
  topic: TopicRef & { talk_count?: number };
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const count = !on && typeof topic.talk_count === 'number' ? topic.talk_count : null;
  // An explicit name, so assistive technology reads "eBPF, 7 talks" and the pressed state,
  // whatever the icon and count spans render as.
  const name = count === null ? topic.label : `${topic.label}, ${count} ${count === 1 ? 'talk' : 'talks'}`;
  return (
    <button
      type="button"
      class={`pp-chip${on ? ' is-on' : ''}`}
      aria-label={name}
      aria-pressed={on}
      disabled={disabled && !on}
      onClick={onToggle}
    >
      {on ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
      <span aria-hidden="true">{topic.label}</span>
      {count !== null && (
        <span class="pp-chip-count" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}

export function TopicPicker({
  slug,
  title,
  hint,
  selected,
  onChange,
  suggestText,
  talkIds,
}: {
  slug: string;
  title: string;
  hint?: string;
  selected: TopicRef[];
  onChange: (next: TopicRef[]) => void;
  suggestText: string;
  talkIds: string[];
}) {
  const [top, setTop] = useState<TopicHit[] | null>(null);
  const [topError, setTopError] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<TopicHit[] | null>(null);
  const [suggested, setSuggested] = useState<TopicHit[]>([]);
  const searchCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    setTop(null);
    setTopError(false);
    topTopics(slug)
      .then((t) => live && setTop(t))
      .catch(() => live && setTopError(true));
    return () => {
      live = false;
    };
  }, [slug]);

  // Type-ahead through Elasticsearch.
  useEffect(() => {
    const term = q.trim();
    searchCtl.current?.abort();
    if (!term) {
      setHits(null);
      return;
    }
    const ctl = new AbortController();
    searchCtl.current = ctl;
    const t = window.setTimeout(() => {
      fetchTopics(slug, term.slice(0, 60), 12, ctl.signal)
        .then((r) => !ctl.signal.aborted && setHits(r.topics ?? []))
        .catch((err) => !isAbort(err) && setHits([]));
    }, 180);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q, slug]);

  // "Suggested for you" from marked talks and free text.
  const idsKey = talkIds.join(',');
  useEffect(() => {
    if (!talkIds.length && !suggestText.trim()) {
      setSuggested([]);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      suggestTopics(slug, talkIds, suggestText.trim(), ctl.signal)
        .then((r) => !ctl.signal.aborted && setSuggested(r.topics ?? []))
        .catch(() => undefined);
    }, 600);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [slug, idsKey, suggestText]);

  const chosen = new Set(selected.map((t) => t.topic_id));
  const full = selected.length >= MAX_TOPICS;

  const toggle = (t: TopicRef) => {
    if (chosen.has(t.topic_id)) onChange(selected.filter((s) => s.topic_id !== t.topic_id));
    else if (!full) onChange([...selected, { topic_id: t.topic_id, label: t.label }]);
  };

  const notChosen = (list: TopicHit[]) => list.filter((t) => !chosen.has(t.topic_id));
  const popular = top ? notChosen(top) : [];
  const shownPopular = showAll ? popular : popular.slice(0, FIRST);
  const sugg = notChosen(suggested).slice(0, 12);
  const headingId = `pp-tp-${title.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <section class="pp-picker" aria-labelledby={headingId}>
      <div class="pp-picker-head">
        <h3 id={headingId} class="pp-picker-title">
          {title}
        </h3>
        <span class="pp-picker-count">
          {selected.length} of {MAX_TOPICS}
        </span>
      </div>
      {hint && <p class="pp-hint">{hint}</p>}

      {selected.length > 0 && (
        <div class="pp-chips" role="group" aria-label="Chosen topics">
          {selected.map((t) => (
            <Chip key={t.topic_id} topic={t} on onToggle={() => toggle(t)} />
          ))}
        </div>
      )}

      <div class="pp-field pp-topic-search">
        <Search size={18} aria-hidden="true" class="pp-field-icon" />
        <input
          type="search"
          value={q}
          placeholder="Find a topic"
          aria-label={`Find a topic for ${title.toLowerCase()}`}
          autocomplete="off"
          enterKeyHint="search"
          maxLength={60}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        {q && (
          <button type="button" class="icon-btn pp-field-clear" aria-label="Clear" onClick={() => setQ('')}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      {hits !== null && (
        <div class="pp-chips" role="group" aria-label="Matching topics">
          {hits.length === 0 && <p class="pp-hint">No topic matches that. Try another word.</p>}
          {hits.map((t) => (
            <Chip key={t.topic_id} topic={t} on={chosen.has(t.topic_id)} disabled={full} onToggle={() => toggle(t)} />
          ))}
        </div>
      )}

      {hits === null && sugg.length > 0 && (
        <>
          <h4 class="pp-subhead">Suggested for you</h4>
          <div class="pp-chips" role="group" aria-label="Suggested topics">
            {sugg.map((t) => (
              <Chip key={t.topic_id} topic={t} on={false} disabled={full} onToggle={() => toggle(t)} />
            ))}
          </div>
        </>
      )}

      {hits === null && (
        <>
          <h4 class="pp-subhead">Common at this conference</h4>
          {topError && <p class="pp-hint">Topics could not be loaded. Check your connection.</p>}
          {!top && !topError && <p class="pp-hint">Loading topics…</p>}
          <div class="pp-chips" role="group" aria-label="Common topics">
            {shownPopular.map((t) => (
              <Chip key={t.topic_id} topic={t} on={false} disabled={full} onToggle={() => toggle(t)} />
            ))}
          </div>
          {popular.length > FIRST && (
            <button type="button" class="btn btn-text btn-small pp-more" onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show fewer' : `Show more (${popular.length - FIRST})`}
            </button>
          )}
        </>
      )}
      {full && <p class="pp-hint">You have chosen 30 topics, the most a set can hold.</p>}
    </section>
  );
}
