import { useEffect, useRef } from 'preact/hooks';
import {
  Check,
  ChevronDown,
  CircleExclamationPoint,
  Search,
  SearchX,
  SlidersHorizontal,
  X,
} from 'lucide-preact';
import type { Conference, Facets, FacetBucket, SearchFilters, SearchResponse, Talk, TagRef } from '../types';
import { EMPTY_FILTERS } from '../types';
import { formatDay } from '../lib/time';
import { useFocusTrap } from '../lib/focus';
import { Segmented } from './common';
import { TalkCard } from './talk';

/** A sheet section id: a fixed group, or "tag:" plus a tag group name. */
export type SheetSection = string;

export function activeFilterCount(f: SearchFilters): number {
  return (
    (f.day ? 1 : 0) +
    (f.start_after || f.start_before ? 1 : 0) +
    f.track.length +
    f.level.length +
    f.tags.length +
    (f.has_slides !== null ? 1 : 0) +
    (f.hide_sponsor ? 1 : 0)
  );
}

function tagValues(f: SearchFilters, group: string): string[] {
  return f.tags.filter((t) => t.group === group).map((t) => t.value);
}

function toggleTag(f: SearchFilters, pair: TagRef): SearchFilters {
  const on = f.tags.some((t) => t.group === pair.group && t.value === pair.value);
  return {
    ...f,
    tags: on ? f.tags.filter((t) => !(t.group === pair.group && t.value === pair.value)) : [...f.tags, pair],
  };
}

/**
 * Every tag value seen for a conference's groups so far, across responses. Facet counts are
 * narrowed by the query and the other filters, so one response alone cannot say how many values a
 * group has; the union only grows, so a group that has shown two values stays a dropdown.
 */
const seenTagValues = new Map<string, Map<string, Set<string>>>();

function rememberTagValues(slug: string, facets: Facets | null, filters: SearchFilters): Map<string, Set<string>> {
  let groups = seenTagValues.get(slug);
  if (!groups) {
    groups = new Map();
    seenTagValues.set(slug, groups);
  }
  for (const t of facets?.tags ?? []) {
    let set = groups.get(t.group);
    if (!set) {
      set = new Set();
      groups.set(t.group, set);
    }
    for (const b of t.values) if (b.count > 0) set.add(String(b.value));
  }
  for (const t of filters.tags) {
    let set = groups.get(t.group);
    if (!set) {
      set = new Set();
      groups.set(t.group, set);
    }
    set.add(t.value);
  }
  return groups;
}

/** The "Has slides" control is hidden when no talk has slides and it is not selected. */
function showSlides(f: SearchFilters, facets: Facets | null): boolean {
  if (f.has_slides !== null) return true;
  return (facets?.has_slides ?? []).some((b) => b.value === true && b.count > 0);
}

type TimeValue = 'any' | 'morning' | 'afternoon';

function timeValue(f: SearchFilters): TimeValue {
  if (f.start_before === '12:00' && !f.start_after) return 'morning';
  if (f.start_after === '12:00' && !f.start_before) return 'afternoon';
  return 'any';
}

function withTime(f: SearchFilters, v: TimeValue): SearchFilters {
  if (v === 'morning') return { ...f, start_after: null, start_before: '12:00' };
  if (v === 'afternoon') return { ...f, start_after: '12:00', start_before: null };
  return { ...f, start_after: null, start_before: null };
}

function groupLabel(name: string, values: string[]): string {
  if (!values.length) return name;
  if (values.length === 1) return values[0];
  return `${name} · ${values.length}`;
}

/* ---------- Search field ---------- */

export function SearchField({
  value,
  onInput,
  onSubmit,
  loading,
}: {
  value: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="search-bar">
      <form
        class="search-field"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          input.current?.blur();
          onSubmit();
        }}
      >
        <Search class="search-icon" size={20} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          enterkeyhint="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          maxLength={200}
          placeholder="Search talks, topics, speakers"
          aria-label="Search talks"
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        />
        {value && (
          <button
            type="button"
            class="icon-btn search-clear"
            aria-label="Clear search"
            onClick={() => {
              onInput('');
              input.current?.focus();
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </form>
      <div class={`progress${loading ? ' is-active' : ''}`} aria-hidden="true" />
    </div>
  );
}

/* ---------- Chip row ---------- */

function Chip({
  label,
  active,
  onOpen,
  onClear,
  clearLabel,
  dropdown,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onClear?: () => void;
  clearLabel?: string;
  dropdown?: boolean;
}) {
  return (
    <span class={`chip${active ? ' is-active' : ''}`}>
      <button type="button" class="chip-main" onClick={onOpen} aria-pressed={dropdown ? undefined : active}>
        {!dropdown && active && <Check size={16} aria-hidden="true" />}
        <span>{label}</span>
        {dropdown && !active && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {active && onClear && (
        <button type="button" class="chip-clear" aria-label={clearLabel} onClick={onClear}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function ChipRow({
  conference,
  filters,
  facets,
  onChange,
  onOpenSheet,
}: {
  conference: Conference;
  filters: SearchFilters;
  facets: Facets | null;
  onChange: (f: SearchFilters) => void;
  onOpenSheet: (section?: SheetSection) => void;
}) {
  const count = activeFilterCount(filters);
  const time = timeValue(filters);
  const seen = rememberTagValues(conference.slug, facets, filters);
  return (
    <div class="chip-row" role="toolbar" aria-label="Filters">
      <span class={`chip${count ? ' is-active' : ''}`}>
        <button
          type="button"
          class="chip-main"
          onClick={() => onOpenSheet()}
          aria-label={count ? `Filters, ${count} active` : 'Filters'}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Filters</span>
          {count > 0 && (
            <span class="badge" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      </span>
      <Chip
        dropdown
        label={filters.day ? formatDay(filters.day) : 'Day'}
        active={!!filters.day}
        onOpen={() => onOpenSheet('day')}
        onClear={() => onChange({ ...filters, day: null })}
        clearLabel="Clear day filter"
      />
      <Chip
        dropdown
        label={time === 'morning' ? 'Morning' : time === 'afternoon' ? 'Afternoon' : 'Time'}
        active={time !== 'any'}
        onOpen={() => onOpenSheet('time')}
        onClear={() => onChange(withTime(filters, 'any'))}
        clearLabel="Clear time filter"
      />
      <Chip
        dropdown
        label={groupLabel('Track', filters.track)}
        active={filters.track.length > 0}
        onOpen={() => onOpenSheet('track')}
        onClear={() => onChange({ ...filters, track: [] })}
        clearLabel="Clear track filter"
      />
      {conference.has_level && (
        <Chip
          dropdown
          label={groupLabel('Level', filters.level)}
          active={filters.level.length > 0}
          onOpen={() => onOpenSheet('level')}
          onClear={() => onChange({ ...filters, level: [] })}
          clearLabel="Clear level filter"
        />
      )}
      {conference.tag_groups.map((group) => {
        const values = tagValues(filters, group);
        // A group with a single value (for example a feed group "End User Programming" whose only
        // value is "End User Talk") reads better as a one-tap toggle named after the value than as
        // a dropdown named after the group. The decision uses every value seen so far, not just
        // this response's counts, and the dropdown stays whenever the selection holds anything the
        // toggle could not show or clear.
        const known = [...(seen.get(group) ?? [])];
        const only = known.length === 1 && values.every((v) => v === known[0]) ? known[0] : null;
        if (only !== null) {
          return (
            <Chip
              key={group}
              label={only}
              active={values.includes(only)}
              onOpen={() => onChange(toggleTag(filters, { group, value: only }))}
            />
          );
        }
        return (
          <Chip
            key={group}
            dropdown
            label={groupLabel(group, values)}
            active={values.length > 0}
            onOpen={() => onOpenSheet(`tag:${group}`)}
            onClear={() => onChange({ ...filters, tags: filters.tags.filter((t) => t.group !== group) })}
            clearLabel={`Clear ${group} filter`}
          />
        );
      })}
      {showSlides(filters, facets) && (
        <Chip
          label={filters.has_slides === false ? 'No slides' : 'Has slides'}
          active={filters.has_slides !== null}
          onOpen={() => onChange({ ...filters, has_slides: filters.has_slides === null ? true : null })}
        />
      )}
      <Chip
        label="Hide sponsor content"
        active={filters.hide_sponsor}
        onOpen={() => onChange({ ...filters, hide_sponsor: !filters.hide_sponsor })}
      />
      {count > 0 && (
        <button type="button" class="chip-clear-all" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear all
        </button>
      )}
    </div>
  );
}

/* ---------- Filter sheet ---------- */

/** Facet options with zero-count values hidden unless they are selected. */
function visible<T>(buckets: FacetBucket<T>[], selected: T[]): FacetBucket<T>[] {
  const shown = buckets.filter((b) => b.count > 0 || selected.includes(b.value));
  for (const s of selected) {
    if (!shown.some((b) => b.value === s)) shown.push({ value: s, count: 0 });
  }
  return shown;
}

export function FilterSheet({
  conference,
  open,
  section,
  filters,
  facets,
  total,
  onChange,
  onClose,
}: {
  conference: Conference;
  open: boolean;
  section?: SheetSection;
  filters: SearchFilters;
  facets: Facets | null;
  total: number | null;
  onChange: (f: SearchFilters) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);

  useEffect(() => {
    if (!open || !section) return;
    const el = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-section]') ?? []).find(
      (e) => e.dataset.section === section,
    );
    el?.scrollIntoView({ block: 'start' });
    el?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  }, [open, section]);

  if (!open) return null;
  const days = visible(facets?.day ?? [], filters.day ? [filters.day] : []);
  const tracks = visible(facets?.track ?? [], filters.track);
  const levels = visible(facets?.level ?? [], filters.level);
  const tagGroups = conference.tag_groups.map((group) => {
    const selected = tagValues(filters, group);
    const facet = facets?.tags?.find((t) => t.group === group);
    return { group, selected, values: visible(facet?.values ?? [], selected) };
  });
  const slides = visible(facets?.has_slides ?? [], filters.has_slides === null ? [] : [filters.has_slides]);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const count = activeFilterCount(filters);

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2 id="sheet-title">Filters</h2>
          <button type="button" class="icon-btn" aria-label="Close filters" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>

        <div class="sheet-body">
          <fieldset class="sheet-section" data-section="day">
            <legend>Day</legend>
            <label class="option">
              <input
                type="radio"
                name="day"
                checked={!filters.day}
                onChange={() => onChange({ ...filters, day: null })}
              />
              <span class="option-label">Any day</span>
            </label>
            {days.map((d) => (
              <label class="option" key={d.value}>
                <input
                  type="radio"
                  name="day"
                  checked={filters.day === d.value}
                  onChange={() => onChange({ ...filters, day: d.value })}
                />
                <span class="option-label">{formatDay(d.value)}</span>
                <span class="option-count">{d.count}</span>
              </label>
            ))}
          </fieldset>

          <fieldset class="sheet-section" data-section="time">
            <legend>Time</legend>
            <Segmented
              label="Time of day"
              value={timeValue(filters)}
              onChange={(v) => onChange(withTime(filters, v))}
              options={[
                { value: 'any', label: 'Any time' },
                { value: 'morning', label: 'Morning' },
                { value: 'afternoon', label: 'Afternoon' },
              ]}
            />
          </fieldset>

          <fieldset class="sheet-section" data-section="track">
            <legend>Track</legend>
            {tracks.length === 0 && <p class="option-empty">No tracks in these results.</p>}
            {tracks.map((t) => (
              <label class="option" key={t.value}>
                <input
                  type="checkbox"
                  checked={filters.track.includes(t.value)}
                  onChange={() => onChange({ ...filters, track: toggle(filters.track, t.value) })}
                />
                <span class="option-label">{t.value}</span>
                <span class="option-count">{t.count}</span>
              </label>
            ))}
          </fieldset>

          {conference.has_level && (
            <fieldset class="sheet-section" data-section="level">
              <legend>Level</legend>
              {levels.length === 0 && <p class="option-empty">No levels in these results.</p>}
              {levels.map((l) => (
                <label class="option" key={l.value}>
                  <input
                    type="checkbox"
                    checked={filters.level.includes(l.value)}
                    onChange={() => onChange({ ...filters, level: toggle(filters.level, l.value) })}
                  />
                  <span class="option-label">{l.value}</span>
                  <span class="option-count">{l.count}</span>
                </label>
              ))}
            </fieldset>
          )}

          {tagGroups.map(({ group, selected, values }) => (
            <fieldset class="sheet-section" data-section={`tag:${group}`} key={group}>
              <legend>{group}</legend>
              {values.length === 0 && <p class="option-empty">None in these results.</p>}
              {values.map((v) => (
                <label class="option" key={v.value}>
                  <input
                    type="checkbox"
                    checked={selected.includes(v.value)}
                    onChange={() => onChange(toggleTag(filters, { group, value: v.value }))}
                  />
                  <span class="option-label">{v.value}</span>
                  <span class="option-count">{v.count}</span>
                </label>
              ))}
            </fieldset>
          ))}

          {showSlides(filters, facets) && (
            <fieldset class="sheet-section" data-section="slides">
              <legend>Slides</legend>
              <label class="option">
                <input
                  type="radio"
                  name="slides"
                  checked={filters.has_slides === null}
                  onChange={() => onChange({ ...filters, has_slides: null })}
                />
                <span class="option-label">Any</span>
              </label>
              {slides.map((s) => (
                <label class="option" key={String(s.value)}>
                  <input
                    type="radio"
                    name="slides"
                    checked={filters.has_slides === s.value}
                    onChange={() => onChange({ ...filters, has_slides: s.value })}
                  />
                  <span class="option-label">{s.value ? 'Has slides' : 'No slides'}</span>
                  <span class="option-count">{s.count}</span>
                </label>
              ))}
            </fieldset>
          )}

          <fieldset class="sheet-section" data-section="sponsor">
            <legend>Sponsor content</legend>
            <label class="option option-switch">
              <span class="option-label">Hide sponsor content</span>
              <input
                type="checkbox"
                role="switch"
                class="switch"
                checked={filters.hide_sponsor}
                onChange={() => onChange({ ...filters, hide_sponsor: !filters.hide_sponsor })}
              />
            </label>
          </fieldset>
        </div>

        <footer class="sheet-footer">
          <button type="button" class="btn btn-text" disabled={!count} onClick={() => onChange(EMPTY_FILTERS)}>
            Clear all
          </button>
          <button type="button" class="btn btn-primary" onClick={onClose}>
            {total === null ? 'Show talks' : `Show ${total} ${total === 1 ? 'talk' : 'talks'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div class="card skeleton" aria-hidden="true">
      <div class="sk sk-title" />
      <div class="sk sk-line sk-short" />
      <div class="sk sk-line" />
      <div class="sk sk-line" />
      <div class="sk sk-line sk-mid" />
    </div>
  );
}

/* ---------- Results ---------- */

export function Results({
  conference,
  data,
  browse,
  loading,
  error,
  interestedIds,
  filtersActive,
  onRetry,
  onToggle,
  onClearFilters,
}: {
  conference: Conference;
  data: SearchResponse | null;
  browse: boolean;
  loading: boolean;
  error: string | null;
  interestedIds: Set<string>;
  filtersActive: boolean;
  onRetry: () => void;
  onToggle: (t: Talk) => void;
  onClearFilters: () => void;
}) {
  if (error && !data) {
    return (
      <div class="state">
        <CircleExclamationPoint size={40} class="state-icon" aria-hidden="true" />
        <p class="state-title">Something went wrong</p>
        <p class="state-body">{error}</p>
        <button type="button" class="btn btn-tonal" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="results" aria-busy="true" aria-label="Loading talks">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  const n = data.total;
  const countLabel = browse ? `All talks · ${n}` : `${n} ${n === 1 ? 'talk' : 'talks'}`;

  return (
    <div aria-busy={loading}>
      {error && (
        <div class="banner" role="alert">
          <CircleExclamationPoint size={18} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" class="btn btn-text btn-small" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      <div class="results-header">
        <p class="results-count" aria-live="polite">
          {countLabel}
        </p>
      </div>
      {data.results.length === 0 ? (
        <div class="state">
          <SearchX size={40} class="state-icon" aria-hidden="true" />
          <p class="state-body">No talks match. Try removing a filter.</p>
          {filtersActive && (
            <button type="button" class="btn btn-tonal" onClick={onClearFilters}>
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <div class="results">
          {data.results.map((r) => (
            <TalkCard
              key={r.talk_id}
              talk={r}
              conference={conference}
              evidence={r.evidence}
              interested={interestedIds.has(r.talk_id)}
              onToggleInterested={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
