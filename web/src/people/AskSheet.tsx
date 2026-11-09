// "Ask to talk shop": a small sheet with a prefilled note and Send. After sending, the sheet
// says so and the person's card shows "No reply yet" until they answer.
import { useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { useFocusTrap } from '../lib/focus';
import { PeopleApiError, requestMeet } from './api';
import { noteSentRequest } from './connect';
import type { PersonResult } from './types';

export const NOTE_MAX = 140;
export const ASKED_COPY = "Asked. You'll hear back here if they accept.";

/** Server text without its <mark> tags or entities, for use inside a note. */
export function plainText(s: string): string {
  return s
    .replace(/<\/?mark>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (w, b: string) =>
      b === 'amp' ? '&' : b === 'lt' ? '<' : b === 'gt' ? '>' : b === 'quot' ? '"' : b === 'apos' ? "'" : b === 'nbsp' ? ' ' : w,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The prefilled note and the topic it names, if the subject is a topic rather than a passage. */
export function prefill(person: PersonResult): { note: string; topicId: string | null } {
  const lead = "I'd like to compare notes on ";
  const evidence = person.evidence ? plainText(person.evidence) : '';
  if (evidence) {
    const room = NOTE_MAX - lead.length;
    const subject = evidence.length > room ? `${evidence.slice(0, room - 1).replace(/\s+\S*$/, '')}…` : evidence;
    return { note: `${lead}${subject}`, topicId: null };
  }
  const topic = person.speak_topics?.[0] ?? person.learn_topics?.[0];
  if (topic) return { note: `${lead}${topic.label}`.slice(0, NOTE_MAX), topicId: topic.topic_id };
  return { note: `${lead}what you're working on`, topicId: null };
}

/** Whether a 409 means an ask is already open (as opposed to the person not being around). */
export const isMeetOpen = (err: unknown) => err instanceof PeopleApiError && err.status === 409 && err.code !== 'not_around';

export function problem(err: unknown): string {
  if (err instanceof PeopleApiError) {
    if (err.code === 'filtered') return err.message;
    if (err.status === 403 && err.code === 'blocked') return "You can't send a request to this person.";
    // Asks are now-only: these two carry the server's own wording.
    if (err.code === 'not_around' || err.code === 'presence_required') return err.message;
    if (err.status === 409) return 'You already have an open request with them.';
    if (err.status === 429) return err.message;
    return err.message;
  }
  return 'That could not be sent. Please try again.';
}

export function AskSheet({ slug, person, onClose }: { slug: string; person: PersonResult; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose, 'textarea');
  const [{ note: initial, topicId }] = useState(() => prefill(person));
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    const text = note.trim();
    if (!text) {
      setError('Add a line about what you want to compare notes on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await requestMeet(slug, person.ref, topicId, text);
      noteSentRequest(slug, person.ref, res.meet_id);
      setSent(true);
    } catch (err) {
      if (isMeetOpen(err)) noteSentRequest(slug, person.ref, `pending:${person.ref}`);
      setError(problem(err));
    }
    setBusy(false);
  };

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet pp-ask" role="dialog" aria-modal="true" aria-labelledby="pp-ask-title" ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2 id="pp-ask-title">Ask to talk shop</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div class="sheet-body pp-ask-body">
          {sent ? (
            <>
              <p class="pp-ask-sent" role="status">
                {ASKED_COPY}
              </p>
              <button type="button" class="btn btn-tonal" onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <p class="pp-hint">
                To {person.display_name}. They see your name, your profile and this note, and have 15 minutes to answer.
              </p>
              <div class="pp-text">
                <label class="pp-label" for="pp-ask-note">
                  Note
                </label>
                <textarea
                  id="pp-ask-note"
                  rows={3}
                  maxLength={NOTE_MAX}
                  value={note}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="pp-ask-hint"
                  onInput={(e) => {
                    setNote((e.target as HTMLTextAreaElement).value);
                    if (error) setError(null);
                  }}
                />
                <p id="pp-ask-hint" class={error ? 'pp-error' : 'pp-hint'}>
                  {error ?? `${note.length} of ${NOTE_MAX}`}
                </p>
              </div>
              <div class="pp-actions">
                <button type="button" class="btn btn-primary" disabled={busy} onClick={send}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
                <button type="button" class="btn btn-text" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
