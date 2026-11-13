// "Import my schedule": a full-screen sheet that sends a schedule file (or pasted text) once to
// the server, which finds the conference's talks in it with Elasticsearch. The user reviews the
// matches and marks the ones they keep as Interested on this device. Nothing is shared. After
// marking, the sheet confirms and offers "View my schedule", which opens My schedule's Day view on
// the first imported day.
import { useEffect, useRef, useState } from 'preact/hooks';
import { CircleCheck, CircleExclamationPoint, ClipboardPaste, FileUp, Info, LoaderCircle, X } from 'lucide-preact';
import type { Conference, SearchResult } from '../types';
import { CLIENT_EXTRACT, ExtractError, extractText, needsExtraction } from './extract';
import { ApiError, importSchedule, isAbort, type ImportConfidence, type ImportPayload, type ImportResponse } from '../api';
import { useFocusTrap } from '../lib/focus';
import { formatWhen, localDay, zoneOf } from '../lib/time';
import { DemoNote } from './demo';
import './import.css';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PASTE = 200_000;
const ACCEPT = '.pdf,.csv,.tsv,.txt,.ics,.json,.docx,.odt,.rtf,application/pdf,text/csv,text/plain,text/calendar,application/json';

const LABELS: Record<ImportConfidence, string> = {
  exact_title: 'Exact title',
  title_and_speaker: 'Title and speaker match',
  title_and_time: 'Title and time match',
  title_words: 'Similar title, please check',
};

const isStrong = (c: ImportConfidence) => c !== 'title_words';

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ImportSheet({
  open,
  conference,
  interestedIds,
  onClose,
  onMark,
  onUndo,
  onViewSchedule,
  onSwitchConference,
}: {
  open: boolean;
  conference: Conference;
  interestedIds: Set<string>;
  onClose: () => void;
  /** Marks the talks as Interested and returns the ids it added. */
  onMark: (talks: SearchResult[]) => string[];
  onUndo: (ids: string[]) => void;
  /** Opens My schedule in Day view on the given local day. */
  onViewSchedule: (day: string) => void;
  onSwitchConference: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const pressedInside = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<{ ids: string[]; day: string } | null>(null);
  const viewButton = useRef<HTMLButtonElement>(null);

  const close = () => {
    controller.current?.abort();
    onClose();
  };
  useFocusTrap(ref, open, close);

  // Every opening starts clean, so nothing from an earlier file stays on screen.
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setPasteOpen(false);
    setPasteText('');
    setResult(null);
    setChecked(new Set());
    setDone(null);
    return () => controller.current?.abort();
  }, [open, conference.slug]);

  useEffect(() => {
    if (done) viewButton.current?.focus();
  }, [done]);

  if (!open) return null;

  const run = async (payload: ImportPayload) => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setBusy(true);
    setError(null);
    try {
      const res = await importSchedule(conference.slug, payload, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setResult(res);
      setChecked(new Set(res.matched.filter((m) => isStrong(m.confidence) && !interestedIds.has(m.talk.talk_id)).map((m) => m.talk.talk_id)));
    } catch (err) {
      if (isAbort(err)) return;
      setError(err instanceof ApiError ? err.message : 'Import is unavailable right now. Please try again.');
    } finally {
      if (controller.current === ctrl) setBusy(false);
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('That file is larger than 5 MB. Export a shorter schedule, or paste its text instead.');
      return;
    }
    if (!file.size) {
      setError('That file is empty.');
      return;
    }
    if (CLIENT_EXTRACT && needsExtraction(file)) {
      // This build's API reads text only, so the file is read here and only its text is sent.
      setBusy(true);
      setError(null);
      try {
        const text = await extractText(file);
        void run({ filename: file.name.slice(0, 255), mime: 'text/plain', text });
      } catch (err) {
        setError(err instanceof ExtractError ? err.message : 'That file could not be opened on this device.');
        setBusy(false);
      }
      return;
    }
    let content: string;
    try {
      content = await fileToBase64(file);
    } catch {
      setError('That file could not be opened on this device.');
      return;
    }
    void run({ filename: file.name.slice(0, 255), mime: (file.type || '').slice(0, 127), content_base64: content });
  };

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const tz = zoneOf(conference);
  const matched = result?.matched ?? [];
  const fresh = matched.filter((m) => !interestedIds.has(m.talk.talk_id));
  const toMark = fresh.filter((m) => checked.has(m.talk.talk_id));
  const strong = matched.filter((m) => isStrong(m.confidence)).length;
  const unmatched = result?.unmatched_count ?? 0;
  // Almost nothing matched well: the file is probably for another conference.
  const fewMatched = !!result && (strong === 0 || (unmatched >= 5 && strong * 4 < unmatched));

  return (
    <div
      class="scrim scrim-full"
      onPointerDown={(e) => {
        pressedInside.current = e.target !== e.currentTarget;
      }}
      onClick={(e) => {
        // A drag that starts in the paste field and ends on the backdrop is not a tap on it.
        const inside = pressedInside.current;
        pressedInside.current = false;
        if (e.target === e.currentTarget && !inside) close();
      }}
    >
      <div class="sheet sheet-full" role="dialog" aria-modal="true" aria-labelledby="import-title" ref={ref} tabIndex={-1}>
        <header class="sheet-header">
          <h2 id="import-title">Import my schedule</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>

        {!result && (
          <div class="sheet-body imp-body" aria-busy={busy}>
            <DemoNote conference={conference} />
            <p class="imp-lead">
              Have a schedule from the official site, a calendar or a spreadsheet? Find its talks at {conference.name} and
              mark them as Interested.
            </p>
            {busy ? (
              <div class="imp-working" role="status">
                <LoaderCircle size={28} class="imp-spin" aria-hidden="true" />
                <span>Reading your schedule…</span>
                <button type="button" class="btn btn-text btn-small" onClick={() => controller.current?.abort()}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <label class="btn btn-primary imp-pick">
                  <FileUp size={20} aria-hidden="true" />
                  Choose a file
                  <input type="file" class="sr-only" accept={ACCEPT} onChange={onFile} />
                </label>
                <p class="imp-formats">PDF, CSV, plain text, calendar (.ics) or JSON, up to 5 MB.</p>
                <button
                  type="button"
                  class="btn btn-text imp-paste-toggle"
                  aria-expanded={pasteOpen}
                  aria-controls="imp-paste"
                  onClick={() => setPasteOpen((o) => !o)}
                >
                  <ClipboardPaste size={20} aria-hidden="true" />
                  Paste text instead
                </button>
                {pasteOpen && (
                  <div class="imp-paste" id="imp-paste">
                    <label class="imp-paste-label" for="imp-text">
                      Your schedule's text
                    </label>
                    <textarea
                      id="imp-text"
                      class="imp-textarea"
                      rows={8}
                      maxLength={MAX_PASTE}
                      value={pasteText}
                      placeholder="Paste the talk titles, one per line, or the whole page"
                      onInput={(e) => setPasteText((e.currentTarget as HTMLTextAreaElement).value)}
                    />
                    <button
                      type="button"
                      class="btn btn-primary"
                      disabled={!pasteText.trim()}
                      onClick={() => void run({ text: pasteText })}
                    >
                      Find talks
                    </button>
                  </div>
                )}
              </>
            )}
            {error && (
              <p class="imp-error" role="alert">
                <CircleExclamationPoint size={18} aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            <p class="imp-note">
              <Info size={16} aria-hidden="true" />
              <span>Your file is read once to find matching talks and is not stored.</span>
            </p>
          </div>
        )}

        {done && (
          <>
            <div class="sheet-body imp-body imp-done" role="status">
              <CircleCheck size={44} class="imp-done-icon" aria-hidden="true" />
              <p class="imp-done-title">Marked {plural(done.ids.length, 'talk', 'talks')} as Interested</p>
              <p class="imp-done-body">They are in My schedule on this device, by day and time.</p>
            </div>
            <footer class="sheet-footer">
              <button
                type="button"
                class="btn btn-text"
                onClick={() => {
                  onUndo(done.ids);
                  setDone(null);
                }}
              >
                Undo
              </button>
              <button type="button" class="btn btn-primary" ref={viewButton} onClick={() => onViewSchedule(done.day)}>
                View my schedule
              </button>
            </footer>
          </>
        )}

        {result && !done && (
          <>
            <div class="sheet-body imp-body">
              <DemoNote conference={conference} />
              <p class="imp-summary" role="status">
                {matched.length
                  ? `Found ${plural(matched.length, 'talk', 'talks')} at ${conference.name}.`
                  : `No talks at ${conference.name} were found in this file.`}
                {unmatched > 0 && ` ${plural(unmatched, 'other entry', 'other entries')} did not match a talk here.`}
              </p>
              {fewMatched && (
                <div class="imp-hint">
                  <p>Few entries matched. Is this schedule for another conference?</p>
                  <button type="button" class="btn btn-tonal btn-small" onClick={onSwitchConference}>
                    Switch conference
                  </button>
                </div>
              )}
              {fresh.some((m) => !isStrong(m.confidence)) && (
                <p class="imp-help">Matches marked “please check” are left unticked. Tick the ones that are right.</p>
              )}
              <ul class="imp-list">
                {matched.map((m) => {
                  const id = m.talk.talk_id;
                  const already = interestedIds.has(id);
                  return (
                    <li key={id}>
                      <label class={`imp-row${already ? ' is-already' : ''}`}>
                        <input
                          type="checkbox"
                          checked={already || checked.has(id)}
                          disabled={already}
                          onChange={() => toggle(id)}
                        />
                        <span class="imp-text">
                          <span class="imp-title">{m.talk.title}</span>
                          <span class="imp-when">{formatWhen(m.talk.start, m.talk.end, tz)}</span>
                          <span class={`imp-badge${isStrong(m.confidence) ? ' is-strong' : ''}`}>
                            {already ? 'Already in Interested' : LABELS[m.confidence]}
                          </span>
                          <span class="imp-excerpt">From your file: “{m.matched_text_excerpt}”</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
            <footer class="sheet-footer">
              <button
                type="button"
                class="btn btn-text"
                onClick={() => {
                  setResult(null);
                  setError(null);
                }}
              >
                Start over
              </button>
              <button
                type="button"
                class="btn btn-primary"
                disabled={!toMark.length}
                onClick={() => {
                  const talks = toMark.map((m) => m.talk);
                  const ids = onMark(talks);
                  if (!ids.length) return;
                  // The earliest imported talk's day, in the conference's zone.
                  const first = talks.filter((t) => ids.includes(t.talk_id)).reduce((a, b) => (Date.parse(b.start) < Date.parse(a.start) ? b : a));
                  setDone({ ids, day: localDay(first.start, tz) });
                }}
              >
                {toMark.length ? `Mark ${plural(toMark.length, 'talk', 'talks')} as Interested` : 'Nothing to mark'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
