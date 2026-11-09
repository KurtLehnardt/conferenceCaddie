// Talk suggestions from the profile on this device. The server ranks them and
// stores nothing; this file only asks and displays.
import { useEffect, useState } from 'preact/hooks';
import { ChevronRight, ExternalLink, Sparkles, Star } from 'lucide-preact';
import { fetchRecommendations, isAbort, PeopleApiError, type RecommendationBody } from './api';
import { getProfile, hasProfileInput, topicsFor, usePeopleStore } from './storage';
import { TalkPeopleControls } from './TalkPeopleControls';
import type { ConferenceLike, InterestedProp, Recommendation, TalkLike } from './types';
import { formatWhen, interestedIds, Marked, useVisibleTick } from './util';

type RecState =
  | { kind: 'loading' }
  | { kind: 'needs_profile' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; results: Recommendation[] };

/** What a finished request produced, and the exact inputs it was computed for. */
interface Settled {
  slug: string;
  key: string;
  outcome: Exclude<RecState, { kind: 'loading' }>;
}

interface RecView {
  state: RecState;
  /** True while the list on screen was computed for earlier inputs and a new one is on its way. */
  refreshing: boolean;
  /** The labels of the topics in the profile now, to check an earlier list against. */
  now: { learn: Set<string> };
}

const FETCH_DELAY_MS = 400;

/**
 * Suggestions for the profile as it is now. The request is keyed on everything that goes into it
 * (conference, learn topics, the learn free text, the Interested list and the size), so any change
 * to those, and every return of the tab to the foreground, asks again. A request that is no
 * longer current is aborted, so an old answer can never replace a newer one.
 *
 * An answer is shown as final only when it was computed for exactly the current key. While a new
 * answer is loading, the earlier list for the same conference stays on screen and `refreshing` is
 * true so it can be dimmed; a list for another conference is never shown.
 */
function useRecommendations(conference: ConferenceLike, interested: InterestedProp, size: number): RecView {
  usePeopleStore();
  const visible = useVisibleTick();
  const slug = conference.slug;
  const p = getProfile();
  const t = topicsFor(p, slug);
  const ready = hasProfileInput(p, slug);
  const body: RecommendationBody = {
    event: slug,
    learn_topics: t.learn.map((x) => x.topic_id),
    interests: p?.interests.trim().slice(0, 500) ?? '',
    // Sorted, so the same list in another order is not a change.
    interested_talk_ids: [...new Set(interestedIds(interested))].sort().slice(0, 100),
    size,
  };
  const key = JSON.stringify(body);
  const [done, setDone] = useState<Settled | null>(null);

  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      fetchRecommendations(body, ctl.signal)
        .then((r) => {
          if (ctl.signal.aborted) return;
          setDone({
            slug,
            key,
            outcome: r.needs_profile ? { kind: 'needs_profile' } : { kind: 'ok', results: r.results ?? [] },
          });
        })
        .catch((err) => {
          if (isAbort(err) || ctl.signal.aborted) return;
          setDone({
            slug,
            key,
            outcome: {
              kind: 'error',
              message: err instanceof PeopleApiError ? err.message : 'Suggestions are unavailable right now.',
            },
          });
        });
    }, FETCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [key, ready, visible]);

  let state: RecState = { kind: 'loading' };
  let refreshing = false;
  if (!ready) {
    state = { kind: 'needs_profile' };
  } else if (done?.slug === slug && done.key === key) {
    state = done.outcome;
  } else if (done?.slug === slug && done.outcome.kind === 'ok') {
    state = done.outcome;
    refreshing = true;
  }
  return {
    state,
    refreshing,
    now: { learn: new Set(t.learn.map((x) => x.label)) },
  };
}

/** The learn topics a suggestion matched. */
function reasonsOf(rec: Recommendation, view: RecView): string[] {
  const learn = rec.why?.learn_topics ?? rec.why?.topics ?? [];
  // A list computed for earlier inputs may name a topic that has since been removed, so it is
  // checked against the profile as it is now. A final answer already holds only the request's topics.
  if (!view.refreshing) return learn;
  return learn.filter((l) => view.now.learn.has(l));
}

/** A thin bar along the bottom edge of its host, shown while an earlier list is being replaced. */
function RefreshBar({ on }: { on: boolean }) {
  return <div class={`pp-progress${on ? ' is-active' : ''}`} aria-hidden="true" />;
}

function PickTopicsPrompt() {
  return (
    <div class="pp-prompt">
      <Sparkles size={22} aria-hidden="true" class="pp-prompt-icon" />
      <div>
        <p class="pp-prompt-title">Pick what you want to learn</p>
        <p class="pp-prompt-body">Pick topics you want to learn, or describe a problem you're facing, to get talk suggestions.</p>
        <a class="btn btn-primary btn-small pp-prompt-btn" href="#/profile">
          Pick topics
        </a>
      </div>
    </div>
  );
}

function Why({ rec, view }: { rec: Recommendation; view: RecView }) {
  const learn = reasonsOf(rec, view);
  return (
    <>
      {learn.length > 0 && (
        <p class="pp-why">
          <span class="pp-why-label">You want to learn:</span> {learn.join(', ')}
        </p>
      )}
      {rec.why?.passage && (
        <p class="pp-passage">
          <Marked text={rec.why.passage} />
        </p>
      )}
    </>
  );
}

/** The short reason on a home-row card: at most two learn topics. */
function miniWhy(rec: Recommendation, view: RecView): string {
  const learn = reasonsOf(rec, view).slice(0, 2);
  return learn.length ? `Learn: ${learn.join(', ')}` : '';
}

/** A talk without the suggestion-only fields, for the shell's Interested list. */
function asTalk(rec: Recommendation): TalkLike {
  const { why: _why, circle_count: _count, ...talk } = rec;
  return talk;
}

export function ForYouRow({
  conference,
  interested,
  onOpenTalk,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onOpenTalk?: (talk: TalkLike) => void;
}) {
  const view = useRecommendations(conference, interested, 5);
  const { state } = view;
  return (
    <section class="pp-section" aria-labelledby="pp-foryou-row">
      <div class="pp-section-head pp-progress-host">
        <h2 id="pp-foryou-row" class="pp-section-title">
          For you
        </h2>
        {state.kind === 'ok' && state.results.length > 0 && (
          <a class="pp-see-all" href="#/for-you">
            See all <ChevronRight size={16} aria-hidden="true" />
          </a>
        )}
        <RefreshBar on={view.refreshing} />
      </div>
      {state.kind === 'needs_profile' && <PickTopicsPrompt />}
      {state.kind === 'loading' && <p class="pp-hint pp-pad">Finding talks…</p>}
      {state.kind === 'error' && <p class="pp-error pp-pad">{state.message}</p>}
      {state.kind === 'ok' && state.results.length === 0 && (
        <p class="pp-hint pp-pad">No upcoming talks match your topics yet. Try adding a few more.</p>
      )}
      {state.kind === 'ok' && state.results.length > 0 && (
        <ul class={`pp-row${view.refreshing ? ' is-refreshing' : ''}`} role="list" aria-busy={view.refreshing}>
          {state.results.slice(0, 5).map((rec) => {
            const why = miniWhy(rec, view);
            return (
              <li key={rec.talk_id} class="pp-row-item">
                <button
                  type="button"
                  class="pp-mini"
                  onClick={() => (onOpenTalk ? onOpenTalk(asTalk(rec)) : window.open(rec.url, '_blank', 'noopener'))}
                >
                  <span class="pp-mini-title">{rec.title}</span>
                  <span class="pp-mini-when">{formatWhen(conference, rec.start)}</span>
                  {why && <span class="pp-mini-why">{why}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ForYouScreen({
  conference,
  interested,
  onToggleInterested,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  onToggleInterested?: (talk: TalkLike) => void;
}) {
  const view = useRecommendations(conference, interested, 20);
  const { state } = view;
  const marked = new Set(interestedIds(interested));

  if (state.kind === 'needs_profile') {
    return (
      <div class="pp-screen">
        <PickTopicsPrompt />
      </div>
    );
  }
  return (
    <div class="pp-screen">
      <div class="pp-progress-host">
        <p class="pp-lede">Talks picked from what you want to learn. Ended talks and talks you marked are left out.</p>
        <RefreshBar on={view.refreshing} />
      </div>
      {state.kind === 'loading' && <p class="pp-hint pp-pad">Finding talks…</p>}
      {state.kind === 'error' && <p class="pp-error pp-pad">{state.message}</p>}
      {state.kind === 'ok' && state.results.length === 0 && (
        <p class="pp-hint pp-pad">No upcoming talks match your topics yet. Try adding a few more.</p>
      )}
      {state.kind === 'ok' && (
        <div class={`pp-list${view.refreshing ? ' is-refreshing' : ''}`} aria-busy={view.refreshing}>
          {state.results.map((rec) => {
            const on = marked.has(rec.talk_id);
            return (
              <article key={rec.talk_id} class="pp-talk-card">
                <h3 class="pp-talk-title">{rec.title}</h3>
                {rec.speakers?.length > 0 && <p class="pp-talk-speakers">{rec.speakers.join(', ')}</p>}
                <p class="pp-talk-meta">
                  {formatWhen(conference, rec.start)}
                  {rec.room ? ` · ${rec.room}` : ''}
                </p>
                <Why rec={rec} view={view} />
                <div class="pp-actions">
                  {onToggleInterested && (
                    <button
                      type="button"
                      class={`btn btn-small ${on ? 'btn-primary' : 'btn-tonal'}`}
                      aria-pressed={on}
                      onClick={() => onToggleInterested(asTalk(rec))}
                    >
                      <Star size={16} aria-hidden="true" fill={on ? 'currentColor' : 'none'} />
                      {on ? 'Interested' : "I'm interested"}
                    </button>
                  )}
                </div>
                <TalkPeopleControls conference={conference} talk={rec} interested={on} circleCount={rec.circle_count} />
                <a class="link" href={rec.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={16} aria-hidden="true" />
                  Add to my schedule on the official site
                </a>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
