// "Import from GitHub": an inline flow for the About you card. The person types a public
// handle, the server reads the public GitHub API and proposes text and topic chips, and the
// person deselects chips and accepts or cancels. Nothing is written anywhere until "Use this",
// and the handle itself never leaves component state: it is not stored on the device or on the
// server, and only what the person accepts reaches the profile fields through onAccept.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Download, Plus } from 'lucide-preact';
import { isAbort, PeopleApiError } from './api';
import { GITHUB_ERROR_COPY, GITHUB_HANDLE_RE, importGithub, normalizeHandle, type GithubProposal } from './importGithub';
import type { Profile, TopicRef } from './types';
import './import.css';

export interface GithubAccepted {
  /** Present only when GitHub had a bio. The parent fills About only when it is empty. */
  about?: string;
  /** Sentences for "Things I've built, run or broken". The parent appends, never overwrites. */
  expertise: string;
  /** The chips left selected, to add to "I can speak to". */
  speakTopics: TopicRef[];
}

const ABOUT_MAX = 280;
const EXPERTISE_MAX = 500;
const SPEAK_MAX = 30;

/**
 * Merges an accepted proposal into the profile without losing anything the person already
 * wrote: About fills only an empty field, the built-things text is appended after a blank line
 * and cut to the field's 500 characters, and new topics are added to "I can speak to" after the
 * current ones. Returns the profile patch and the next speak list for setTopics.
 */
export function mergeGithubImport(
  profile: Pick<Profile, 'about' | 'expertise'>,
  speak: TopicRef[],
  accepted: GithubAccepted,
): { patch: Partial<Profile>; speak: TopicRef[] } {
  const patch: Partial<Profile> = {};
  if (accepted.about && !profile.about.trim()) patch.about = accepted.about.slice(0, ABOUT_MAX);
  const addition = accepted.expertise.trim();
  if (addition) {
    const current = profile.expertise.trimEnd();
    patch.expertise = (current ? `${current}\n\n${addition}` : addition).slice(0, EXPERTISE_MAX);
  }
  const have = new Set(speak.map((t) => t.topic_id));
  const next = [...speak];
  for (const t of accepted.speakTopics) {
    if (next.length >= SPEAK_MAX) break;
    if (!have.has(t.topic_id)) {
      have.add(t.topic_id);
      next.push(t);
    }
  }
  return { patch, speak: next };
}

type Step = { kind: 'idle' } | { kind: 'form' } | { kind: 'loading' } | { kind: 'preview'; proposal: GithubProposal };

export function ImportGitHub({ slug, onAccept }: { slug: string; onAccept: (accepted: GithubAccepted) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (step.kind === 'form') inputRef.current?.focus();
  }, [step.kind]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setHandle('');
    setError(null);
    setChosen(new Set());
    setStep({ kind: 'idle' });
  };

  const fetchProposal = async (e?: Event) => {
    e?.preventDefault();
    const h = normalizeHandle(handle);
    if (!GITHUB_HANDLE_RE.test(h)) {
      setError(GITHUB_ERROR_COPY.invalid);
      return;
    }
    setError(null);
    setDone(null);
    setStep({ kind: 'loading' });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const proposal = await importGithub(slug, h, ac.signal);
      if (ac.signal.aborted) return;
      setChosen(new Set(proposal.suggested_speak_topics.map((t) => t.topic_id)));
      setStep({ kind: 'preview', proposal });
    } catch (err) {
      if (isAbort(err)) return;
      setError(err instanceof PeopleApiError ? err.message : GITHUB_ERROR_COPY.upstream);
      setStep({ kind: 'form' });
    }
  };

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const accept = (proposal: GithubProposal) => {
    const speakTopics = proposal.suggested_speak_topics.filter((t) => chosen.has(t.topic_id));
    onAccept({ about: proposal.about || undefined, expertise: proposal.expertise, speakTopics });
    const bits: string[] = [];
    if (proposal.expertise) bits.push('your built things');
    if (speakTopics.length) bits.push(`${speakTopics.length} ${speakTopics.length === 1 ? 'topic' : 'topics'}`);
    setDone(bits.length ? `Added ${bits.join(' and ')}. Edit anything above.` : 'Nothing to add from that profile.');
    reset();
  };

  if (step.kind === 'idle') {
    return (
      <div class="pp-gh">
        <button type="button" class="btn btn-tonal btn-small pp-import" onClick={() => setStep({ kind: 'form' })}>
          <Download size={16} aria-hidden="true" />
          Import from GitHub
        </button>
        {done && (
          <p class="pp-hint" role="status">
            {done}
          </p>
        )}
      </div>
    );
  }

  if (step.kind === 'form' || step.kind === 'loading') {
    const busy = step.kind === 'loading';
    return (
      <form class="pp-gh pp-gh-form" onSubmit={fetchProposal}>
        <div class="pp-text">
          <label class="pp-label" for="pp-gh-handle">
            GitHub user name
          </label>
          <div class="pp-gh-row">
            <input
              id="pp-gh-handle"
              ref={inputRef}
              type="text"
              value={handle}
              maxLength={120}
              placeholder="octocat"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby="pp-gh-hint"
              onInput={(e) => {
                setHandle((e.target as HTMLInputElement).value);
                if (error) setError(null);
              }}
            />
            <button type="submit" class="btn btn-primary btn-small" disabled={busy || !handle.trim()}>
              {busy ? 'Fetching…' : 'Fetch'}
            </button>
          </div>
          <p id="pp-gh-hint" class={error ? 'pp-error' : 'pp-hint'} role={error ? 'alert' : undefined}>
            {error ?? 'We read your public repositories and propose text and topics. You choose what to keep; the user name is not saved.'}
          </p>
        </div>
        <div class="pp-actions">
          <button type="button" class="btn btn-text btn-small" onClick={reset}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  const { proposal } = step;
  const nothing = !proposal.about && !proposal.expertise && proposal.suggested_speak_topics.length === 0;
  return (
    <div class="pp-gh pp-gh-preview" role="region" aria-label="Proposed from GitHub">
      <p class="pp-hint">
        From {proposal.repo_count} public {proposal.repo_count === 1 ? 'repository' : 'repositories'}. Nothing is saved until you tap
        “Use this”.
      </p>
      {proposal.about && (
        <div class="pp-gh-block">
          <h3 class="pp-gh-title">About me</h3>
          <p class="pp-gh-text">{proposal.about}</p>
        </div>
      )}
      {proposal.expertise && (
        <div class="pp-gh-block">
          <h3 class="pp-gh-title">Things I've built, run or broken</h3>
          <p class="pp-gh-text">{proposal.expertise}</p>
        </div>
      )}
      {proposal.suggested_speak_topics.length > 0 && (
        <div class="pp-gh-block">
          <h3 class="pp-gh-title">I can speak to</h3>
          <div class="pp-chips" role="group" aria-label="Suggested topics">
            {proposal.suggested_speak_topics.map((t) => {
              const on = chosen.has(t.topic_id);
              return (
                <button
                  type="button"
                  key={t.topic_id}
                  class={`pp-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(t.topic_id)}
                >
                  {on ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {proposal.extra_terms.length > 0 && (
        <p class="pp-hint pp-gh-extra">
          Also found, but not topics at this conference: {proposal.extra_terms.slice(0, 8).join(', ')}. You can mention them in your text.
        </p>
      )}
      {nothing && <p class="pp-hint">That account has no public bio, described repositories or matching topics.</p>}
      <div class="pp-actions">
        <button type="button" class="btn btn-primary btn-small" disabled={nothing} onClick={() => accept(proposal)}>
          Use this
        </button>
        <button type="button" class="btn btn-text btn-small" onClick={reset}>
          Cancel
        </button>
      </div>
    </div>
  );
}
