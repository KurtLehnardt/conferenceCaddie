import { useRef } from 'preact/hooks';
import { Check, ChevronDown, ExternalLink, X } from 'lucide-preact';
import type { Conference } from '../types';
import { useFocusTrap } from '../lib/focus';
import { formatDateRange } from '../lib/time';

function place(c: Conference): string {
  const loc = c.location;
  if (!loc) return '';
  if (loc.virtual) return 'Virtual';
  return [loc.city, loc.country].filter(Boolean).join(', ');
}

/** The app bar title: the current conference's name with a chevron that opens the switcher. */
export function SwitcherButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button type="button" class="switcher-btn" onClick={onOpen} aria-haspopup="dialog">
      <span class="switcher-name">{name}</span>
      <ChevronDown size={20} aria-hidden="true" />
      <span class="sr-only">, change conference</span>
    </button>
  );
}

/**
 * A bottom sheet listing searchable conferences first. Conferences whose schedule
 * is not available here are links out to the official schedule, not routes.
 */
export function SwitcherSheet({
  open,
  conferences,
  current,
  error,
  onPick,
  onClose,
}: {
  open: boolean;
  conferences: Conference[] | null;
  current: string | null;
  error: string | null;
  onPick: (slug: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose, '[aria-current="true"]');
  if (!open) return null;
  const searchable = (conferences ?? []).filter((c) => c.status === 'searchable');
  const unavailable = (conferences ?? []).filter((c) => c.status !== 'searchable');

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="switcher-title" ref={ref} tabIndex={-1}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-header">
          <h2 id="switcher-title">Conferences</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div class="sheet-body">
          {error && !conferences && <p class="option-empty">{error}</p>}
          {searchable.length > 0 && (
            <ul class="conf-list" aria-label="Searchable conferences">
              {searchable.map((c) => (
                <li key={c.slug}>
                  <button
                    type="button"
                    class="conf-row"
                    aria-current={c.slug === current ? 'true' : undefined}
                    onClick={() => onPick(c.slug)}
                  >
                    <span class="conf-text">
                      <span class="conf-name">{c.name}</span>
                      <span class="conf-meta">
                        {[formatDateRange(c.start_date, c.end_date), place(c)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {c.slug === current && <Check size={20} class="conf-check" aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {unavailable.length > 0 && (
            <section class="conf-section" aria-labelledby="conf-unavailable">
              <h3 class="conf-heading" id="conf-unavailable">
                Schedule not available here yet
              </h3>
              <ul class="conf-list">
                {unavailable.map((c) => (
                  <li key={c.slug}>
                    <a class="conf-row" href={c.official_schedule_url} target="_blank" rel="noopener noreferrer">
                      <span class="conf-text">
                        <span class="conf-name">{c.name}</span>
                        <span class="conf-meta">
                          {[formatDateRange(c.start_date, c.end_date), place(c)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <ExternalLink size={18} class="conf-check" aria-hidden="true" />
                      <span class="sr-only">, opens the official schedule in a new tab</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
