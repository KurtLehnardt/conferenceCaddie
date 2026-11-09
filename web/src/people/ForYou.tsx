// Talk suggestions from the profile on this device. The server ranks them and
// stores nothing; this file only asks and displays.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronRight, ExternalLink, Sparkles, Star } from 'lucide-preact';
import { fetchRecommendations, isAbort, PeopleApiError } from './api';
import { getProfile, hasProfileInput, topicsFor, usePeopleStore } from './storage';
import { TalkPeopleControls } from './TalkPeopleControls';
import type { ConferenceLike, InterestedProp, Recommendation, TalkLike } from './types';
import { formatWhen, interestedIds, Marked } from './util';

type RecState =
  | { kind: 'loading' }
  | { kind: 'needs_profile' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; results: Recommendation[] };

function useRecommendations(conference: ConferenceLike, interested: InterestedProp, size: number): RecState {
  usePeopleStore();
  const slug = conference.slug;
  const p = getProfile();
  const t = topicsFor(p, slug);
  const ready = hasProfileInput(p, slug);
  // Refetch when the inputs change, not on every store update.
  const stamp = JSON.stringify([
    t.learn.map((x) => x.topic_id),
    t.speak.map((x) => x.topic_id),
    p?.interests.trim() ?? '',
    p?.expertise.trim() ?? '',
  ]);
  const ids = useRef<string[]>([]);
  ids.current = interestedIds(interested);
  const [state, setState] = useState<RecState>({ kind: 'loading' });

  useEffect(() => {
    if (!ready) {
      setState({ kind: 'needs_profile' });
      return;
    }
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      const prof = getProfile();
      const topics = topicsFor(prof, slug);
      fetchRecommendations(
        {
          event: slug,
          learn_topics: topics.learn.map((x) => x.topic_id),
          speak_topics: topics.speak.map((x) => x.topic_id),
          interests: prof?.interests.trim().slice(0, 500) ?? '',
          expertise: prof?.expertise.trim().slice(0, 500) ?? '',
          interested_talk_ids: ids.current.slice(0, 100),
          size,
        },
        ctl.signal,
      )
        .then((r) => {
          if (ctl.signal.aborted) return;
          setState(r.needs_profile ? { kind: 'needs_profile' } : { kind: 'ok', results: r.results ?? [] });
        })
        .catch((err) => {
          if (isAbort(err)) return;
          setState({
            kind: 'error',
            message: err instanceof PeopleApiError ? err.message : 'Suggestions are unavailable right now.',
          });
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [slug, stamp, ready, size]);

  return state;
}

function PickTopicsPrompt() {
  return (
    <div class="pp-prompt">
      <Sparkles size={22} aria-hidden="true" class="pp-prompt-icon" />
      <div>
        <p class="pp-prompt-title">Pick a few topics</p>
        <p class="pp-prompt-body">Choose what you want to learn about, and we'll suggest talks.</p>
        <a class="btn btn-primary btn-small pp-prompt-btn" href="#/profile">
          Pick topics
        </a>
      </div>
    </div>
  );
}

function Why({ rec }: { rec: Recommendation }) {
  const topics = rec.why?.topics ?? [];
  return (
    <>
      {topics.length > 0 && (
        <p class="pp-why">
          <span class="pp-why-label">Matches:</span> {topics.join(', ')}
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
  const state = useRecommendations(conference, interested, 5);
  return (
    <section class="pp-section" aria-labelledby="pp-foryou-row">
      <div class="pp-section-head">
        <h2 id="pp-foryou-row" class="pp-section-title">
          For you
        </h2>
        {state.kind === 'ok' && state.results.length > 0 && (
          <a class="pp-see-all" href="#/for-you">
            See all <ChevronRight size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {state.kind === 'needs_profile' && <PickTopicsPrompt />}
      {state.kind === 'loading' && <p class="pp-hint pp-pad">Finding talks…</p>}
      {state.kind === 'error' && <p class="pp-error pp-pad">{state.message}</p>}
      {state.kind === 'ok' && state.results.length === 0 && (
        <p class="pp-hint pp-pad">No upcoming talks match your topics yet. Try adding a few more.</p>
      )}
      {state.kind === 'ok' && state.results.length > 0 && (
        <ul class="pp-row" role="list">
          {state.results.slice(0, 5).map((rec) => (
            <li key={rec.talk_id} class="pp-row-item">
              <button
                type="button"
                class="pp-mini"
                onClick={() => (onOpenTalk ? onOpenTalk(asTalk(rec)) : window.open(rec.url, '_blank', 'noopener'))}
              >
                <span class="pp-mini-title">{rec.title}</span>
                <span class="pp-mini-when">{formatWhen(conference, rec.start)}</span>
                {rec.why?.topics?.length > 0 && <span class="pp-mini-why">{rec.why.topics.slice(0, 3).join(', ')}</span>}
              </button>
            </li>
          ))}
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
  const state = useRecommendations(conference, interested, 20);
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
      <p class="pp-lede">Talks picked from your topics. Ended talks and talks you marked are left out.</p>
      {state.kind === 'loading' && <p class="pp-hint pp-pad">Finding talks…</p>}
      {state.kind === 'error' && <p class="pp-error pp-pad">{state.message}</p>}
      {state.kind === 'ok' && state.results.length === 0 && (
        <p class="pp-hint pp-pad">No upcoming talks match your topics yet. Try adding a few more.</p>
      )}
      {state.kind === 'ok' && (
        <div class="pp-list">
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
                <Why rec={rec} />
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
