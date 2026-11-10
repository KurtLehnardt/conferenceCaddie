// "Report": a small sheet with the reason list and one confirming step, like the block dialog.
// It reports a person's profile (from their card), their spot line or a meet. The reporter is
// told only "Thanks. We'll look at it."; they never learn whether others reported too.
import { useRef, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { useFocusTrap } from '../lib/focus';
import { PeopleApiError, reportPerson } from './api';
import type { ReportKind, ReportReason } from './types';
import { toast } from './ui';

export const REPORT_THANKS = "Thanks. We'll look at it.";

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'harassment', label: 'Harassment' },
  { value: 'hate', label: 'Hateful content' },
  { value: 'sexual', label: 'Sexual content' },
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'other', label: 'Something else' },
];

const SUBJECT: Record<ReportKind, string> = {
  profile: 'their profile',
  spot: 'their spot line',
  meet: 'this meet-up',
};

function problem(err: unknown): string {
  if (err instanceof PeopleApiError) {
    if (err.status === 404) return "This couldn't be found any more.";
    if (err.status === 403 && err.code === 'profile_required') return 'Set up your profile first.';
    return err.message;
  }
  return 'That could not be sent. Please try again.';
}

export interface ReportTarget {
  /** The reported person's ref (never shown). */
  ref: string;
  display_name: string;
  kind: ReportKind;
  /** The ref again for profile and spot, the meet_id for a meet. */
  id: string;
}

export function ReportSheet({ slug, target, onClose }: { slug: string; target: ReportTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose, '[data-autofocus]');
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!reason) {
      setError('Pick a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reportPerson(slug, target.ref, target.kind, target.id, reason);
      toast(REPORT_THANKS);
      onClose();
    } catch (err) {
      setError(problem(err));
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet pp-report" role="dialog" aria-modal="true" aria-labelledby="pp-report-title" ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2 id="pp-report-title">Report {target.display_name}</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div class="sheet-body pp-report-body">
          <p class="pp-hint">What's wrong with {SUBJECT[target.kind]}? They are not told who reported.</p>
          <fieldset class="pp-report-reasons" aria-describedby="pp-report-hint">
            <legend class="sr-only">Reason</legend>
            {REPORT_REASONS.map((r, i) => (
              <label key={r.value} class="option">
                <input
                  type="radio"
                  name="pp-report-reason"
                  value={r.value}
                  checked={reason === r.value}
                  data-autofocus={i === 0 ? true : undefined}
                  onChange={() => {
                    setReason(r.value);
                    if (error) setError(null);
                  }}
                />
                <span class="option-label">{r.label}</span>
              </label>
            ))}
          </fieldset>
          <p id="pp-report-hint" class={error ? 'pp-error' : 'pp-hint'}>
            {error ?? 'Two reports from different people hide it from everyone until we have looked.'}
          </p>
          <div class="pp-actions">
            <button type="button" class="btn btn-danger" disabled={busy} onClick={send}>
              {busy ? 'Sending…' : 'Report'}
            </button>
            <button type="button" class="btn btn-text" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
