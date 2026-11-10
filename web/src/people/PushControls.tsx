// The "Nudge me even when the app is closed" switch: the first-time notice, the Add to Home
// Screen step (an explainer on iOS Safari, the install prompt on Android Chrome), the permission
// request, and the "On" state. Used under the presence switch and in Settings.
import { useEffect, useState } from 'preact/hooks';
import { BellRing, Share, SquarePlus } from 'lucide-preact';
import {
  canPromptInstall,
  isIos,
  isStandalone,
  onInstallChange,
  promptInstall,
  PUSH_DENIED_HINT,
  PUSH_LABEL,
  PUSH_NOTICE,
  subscribePush,
  supportsPush,
  unsubscribePush,
} from './push';
import { getPush, setPush, usePeopleStore } from './storage';
import { toast } from './ui';

type Panel = 'notice' | 'ios' | 'install' | 'denied' | 'hint';

/** The switch is shown wherever push can work, or could after installing (iOS). */
export function pushAvailable(): boolean {
  return supportsPush() || isIos();
}

export function PushSwitch({
  slug,
  variant,
}: {
  slug: string;
  /** 'card' sits inside the presence card; 'settings' uses the settings rows. */
  variant: 'card' | 'settings';
}) {
  usePeopleStore();
  const state = getPush(slug);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);

  if (!pushAvailable()) return null;

  const finish = async () => {
    setBusy(true);
    const r = await subscribePush(slug);
    setBusy(false);
    if (r.ok) {
      setPanel(null);
      setHint(null);
      toast('Nudges on');
      return;
    }
    if (r.reason === 'denied') setPanel('denied');
    else if (r.reason === 'dismissed') setPanel(null);
    else {
      setHint(
        r.reason === 'unavailable'
          ? "Nudges aren't set up on this server yet."
          : r.reason === 'unsupported'
            ? "This browser can't deliver nudges while the app is closed."
            : r.reason === 'profile'
              ? 'Nudges need a visible profile.'
              : 'Nudges could not be turned on. Please try again.',
      );
      setPanel('hint');
    }
  };

  // The step after the notice: where the app runs decides what comes first.
  const start = () => {
    if (isIos() && !isStandalone()) {
      setPanel('ios');
      return;
    }
    if (canPromptInstall() && !isStandalone()) {
      setPanel('install');
      return;
    }
    void finish();
  };

  const onSwitch = (on: boolean) => {
    setHint(null);
    if (!on) {
      setPanel(null);
      if (state.on) void unsubscribePush(slug);
      return;
    }
    if (!state.notice_seen) setPanel('notice');
    else start();
  };

  const acceptNotice = () => {
    setPush(slug, { notice_seen: true });
    start();
  };

  const install = async () => {
    setBusy(true);
    await promptInstall();
    setBusy(false);
    // Installed or not, the permission step follows; the installed app shares this permission.
    void finish();
  };

  const pending = panel === 'notice' || panel === 'install' || busy;
  const rowClass = variant === 'settings' ? 'settings-row' : 'pp-switch-row';
  const textClass = variant === 'settings' ? 'settings-row settings-text' : 'pp-hint';

  return (
    <div class={variant === 'settings' ? 'pp-push pp-push-settings' : 'pp-push'}>
      <label class={rowClass}>
        <span class="pp-push-label">
          {variant === 'card' && <BellRing size={16} aria-hidden="true" />}
          <span>{PUSH_LABEL}</span>
        </span>
        <span class="pp-push-right">
          {state.on && !panel && <span class="pp-push-state">On</span>}
          <input
            type="checkbox"
            role="switch"
            class="switch"
            aria-label={PUSH_LABEL}
            checked={state.on || pending}
            disabled={busy}
            onChange={(e) => onSwitch((e.target as HTMLInputElement).checked)}
          />
        </span>
      </label>
      {panel === 'notice' && (
        <div class="pp-push-panel">
          <div class="pp-notice" role="region" aria-label="About nudges">
            <p>{PUSH_NOTICE}</p>
          </div>
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={acceptNotice}>
              Turn on nudges
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => setPanel(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {panel === 'ios' && (
        <div class="pp-push-panel pp-push-ios" role="region" aria-label="Add to Home Screen">
          <p class="pp-push-ios-title">Add Caddie to your Home Screen first</p>
          <p class="pp-push-ios-step">
            <Share size={18} aria-hidden="true" />
            <span>
              Tap <strong>Share</strong> in Safari's toolbar.
            </span>
          </p>
          <p class="pp-push-ios-step">
            <SquarePlus size={18} aria-hidden="true" />
            <span>
              Choose <strong>Add to Home Screen</strong>, then open Caddie from there and turn this on.
            </span>
          </p>
        </div>
      )}
      {panel === 'install' && (
        <div class="pp-push-panel">
          <p class={textClass}>Nudges work best from your Home Screen.</p>
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={install}>
              <SquarePlus size={18} aria-hidden="true" />
              Add to Home Screen
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => void finish()}>
              Continue without installing
            </button>
          </div>
        </div>
      )}
      {panel === 'denied' && <p class={`${textClass} pp-push-hint`}>{PUSH_DENIED_HINT}</p>}
      {panel === 'hint' && hint && (
        <p class={`${textClass} pp-push-hint`}>
          {hint}
          {hint.includes('profile') && (
            <>
              {' '}
              <a class="pp-inline-link" href="#/profile">
                Open my profile
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
