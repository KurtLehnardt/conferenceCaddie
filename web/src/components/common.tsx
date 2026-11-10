import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { EllipsisVertical, Search, Sparkles, Star, Users } from 'lucide-preact';
import { useFocusTrap } from '../lib/focus';
import { tabHash, type Tab, type TabParams } from '../lib/route';

const TABS: { id: Tab; label: string; Icon: typeof Search }[] = [
  { id: 'people', label: 'People', Icon: Users },
  { id: 'for-you', label: 'For you', Icon: Sparkles },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'interested', label: 'Interested', Icon: Star },
];

/** Bottom tab bar on phones; the same element becomes a left rail from 768px. */
export function NavBar({
  tab,
  base,
  interestedCount,
  peopleCount = 0,
  views = {},
}: {
  tab: Tab;
  base: string;
  interestedCount: number;
  /** Requests waiting in the inbox, shown on the People tab. */
  peopleCount?: number;
  /** The view and day last shown on each tab, so going back to a tab keeps them. */
  views?: Partial<Record<Tab, TabParams>>;
}) {
  const badge = (id: Tab) => (id === 'interested' ? interestedCount : id === 'people' ? peopleCount : 0);
  const name = (id: Tab) => {
    if (id === 'interested' && interestedCount) return `Interested, ${interestedCount} talks`;
    if (id === 'people' && peopleCount) return `People, ${peopleCount} new ${peopleCount === 1 ? 'request' : 'requests'}`;
    return undefined;
  };
  return (
    <nav class="nav" aria-label="Main">
      <div class="nav-brand" aria-hidden="true">
        <img src="/icons/icon-192.png" alt="" width={32} height={32} />
      </div>
      {TABS.map(({ id, label, Icon }) => (
        <a
          key={id}
          href={`${base}${tabHash(id, views[id])}`}
          class="nav-item"
          aria-current={tab === id ? 'page' : undefined}
          aria-label={name(id)}
        >
          <span class="nav-icon">
            <Icon size={24} strokeWidth={tab === id ? 2.25 : 1.75} aria-hidden="true" />
            {badge(id) > 0 && (
              <span class="badge nav-badge" aria-hidden="true">
                {badge(id) > 99 ? '99+' : badge(id)}
              </span>
            )}
          </span>
          <span class="nav-label">{label}</span>
        </a>
      ))}
    </nav>
  );
}

export function AppBar({
  leading,
  title,
  actions,
}: {
  leading?: ComponentChildren;
  title: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <header class={`appbar${leading ? ' has-leading' : ''}`}>
      {leading}
      <h1 class="appbar-title">{title}</h1>
      <div class="appbar-actions">{actions}</div>
    </header>
  );
}

export interface ToastData {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
}

export function Toast({ toast, onDismiss }: { toast: ToastData | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [toast?.id]);

  return (
    <div class="toast-region" role="status" aria-live="polite">
      {toast && (
        <div class="toast" key={toast.id}>
          <span class="toast-msg">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              class="toast-action"
              onClick={() => {
                toast.action!.onClick();
                onDismiss();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface ConfirmData {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export function ConfirmDialog({ data, onClose }: { data: ConfirmData | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, !!data, onClose, '[data-autofocus]');
  if (!data) return null;
  return (
    <div class="scrim scrim-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-body"
        ref={ref}
        tabIndex={-1}
      >
        <h2 id="dialog-title" class="dialog-title">
          {data.title}
        </h2>
        <p id="dialog-body" class="dialog-body">
          {data.body}
        </p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-text" data-autofocus onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-danger"
            onClick={() => {
              data.onConfirm();
              onClose();
            }}
          >
            {data.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** A vertical-dots overflow menu anchored to the right of the app bar. */
export function OverflowMenu({ items, label = 'More options' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
        const i = els.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div class="menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        class="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EllipsisVertical size={22} aria-hidden="true" />
      </button>
      {open && (
        <div class="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              class={`menu-item${it.destructive ? ' is-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  // A radio group: one tab stop, and the arrow keys move the choice, as platform controls do.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div class="segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          class="segment"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
