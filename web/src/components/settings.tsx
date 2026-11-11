import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ChevronRight, CircleQuestionMark, ExternalLink, FileUp, Smartphone, UserRound } from 'lucide-preact';
import type { ThemePref } from '../lib/storage';
import { useProfileName } from '../people/index';
import { Segmented } from './common';
import { isStandalone, openInstallCard } from './install';

declare const __APP_VERSION__: string;

const HELP_LABEL = 'Show the welcome guide';

/**
 * The help icon at the bottom of Settings. The tooltip shows on mouse hover and on keyboard focus,
 * and Escape hides it. A tap does not rely on it: the tap itself starts the guide.
 */
function HelpButton({ onClick }: { onClick: () => void }) {
  const [tip, setTip] = useState(false);
  return (
    <div class="settings-help">
      <button
        type="button"
        class="icon-btn"
        aria-label={HELP_LABEL}
        data-guide-help
        onClick={() => {
          setTip(false);
          onClick();
        }}
        onPointerEnter={(e) => e.pointerType !== 'touch' && setTip(true)}
        onPointerLeave={() => setTip(false)}
        onFocus={(e) => {
          // Safari before 15.4 throws on :focus-visible; show the tip on focus there.
          let visible = true;
          try {
            visible = (e.currentTarget as HTMLElement).matches(':focus-visible');
          } catch {
            // Keep the default.
          }
          if (visible) setTip(true);
        }}
        onBlur={() => setTip(false)}
        onKeyDown={(e) => e.key === 'Escape' && tip && (e.stopPropagation(), setTip(false))}
      >
        <CircleQuestionMark size={22} aria-hidden="true" />
      </button>
      {tip && (
        <span class="settings-tip" aria-hidden="true">
          {HELP_LABEL}
        </span>
      )}
    </div>
  );
}

export function SettingsScreen({
  theme,
  onTheme,
  canImport,
  importNote,
  onImport,
  people,
  onHelp,
}: {
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  /** True when a searchable conference is open and the device is online. */
  canImport: boolean;
  /** Why import is unavailable, shown in place of the usual hint. */
  importNote: string | null;
  onImport: () => void;
  /** The people sections (blocked people, people I met, people I watch) for the current conference. */
  people?: ComponentChildren;
  /** Starts the welcome guide again. The help icon is shown only when this is given. */
  onHelp?: () => void;
}) {
  const name = useProfileName();
  return (
    <div class="settings">
      <section class="settings-group" aria-labelledby="set-you">
        <h2 class="settings-heading" id="set-you">
          You
        </h2>
        <div class="settings-card">
          <a class="settings-row settings-nav" href="#/profile">
            <UserRound size={20} class="settings-icon" aria-hidden="true" />
            <span class="settings-nav-text">
              <span class="settings-label">Profile</span>
              <span class="settings-hint">{name || 'Set up your profile'}</span>
            </span>
            <ChevronRight size={18} class="settings-chevron" aria-hidden="true" />
          </a>
          <button type="button" class="settings-row settings-nav" disabled={!canImport} onClick={onImport}>
            <FileUp size={20} class="settings-icon" aria-hidden="true" />
            <span class="settings-nav-text">
              <span class="settings-label">Import my schedule</span>
              <span class="settings-hint">{importNote ?? 'Find talks from a PDF, CSV, calendar or text file'}</span>
            </span>
            <ChevronRight size={18} class="settings-chevron" aria-hidden="true" />
          </button>
        </div>
      </section>

      {people}

      <section class="settings-group" aria-labelledby="set-appearance">
        <h2 class="settings-heading" id="set-appearance">
          Appearance
        </h2>
        <div class="settings-card">
          <div class="settings-row settings-row-stack">
            <span class="settings-label" id="theme-label">
              Theme
            </span>
            <Segmented
              label="Theme"
              value={theme}
              onChange={onTheme}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </div>
      </section>

      {!isStandalone() && (
        <section class="settings-group" aria-labelledby="set-install">
          <h2 class="settings-heading" id="set-install">
            Home screen
          </h2>
          <div class="settings-card">
            <button type="button" class="settings-row settings-link" onClick={openInstallCard}>
              <span>Add Conference Caddie to your home screen</span>
              <Smartphone size={18} aria-hidden="true" />
            </button>
          </div>
        </section>
      )}

      <section class="settings-group" aria-labelledby="set-about">
        <h2 class="settings-heading" id="set-about">
          About
        </h2>
        <div class="settings-card">
          <p class="settings-row settings-text">
            Conference Caddie helps you find the people to talk to and the talks you would like. Your official
            schedule stays on each conference's own site.
          </p>
          <p class="settings-row settings-text">Times are shown in each event's local time.</p>
          <p class="settings-row settings-text">
            Schedule data comes from each conference's Sessionize feed, discovered through events.linuxfoundation.org.
          </p>
          <a
            class="settings-row settings-link"
            href="https://github.com/KurtLehnardt/conferenceCaddie"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>Source code</span>
            <ExternalLink size={18} aria-hidden="true" />
          </a>
          <div class="settings-row">
            <span>Version</span>
            <span class="settings-value">{__APP_VERSION__}</span>
          </div>
        </div>
      </section>

      {onHelp && <HelpButton onClick={onHelp} />}
    </div>
  );
}
