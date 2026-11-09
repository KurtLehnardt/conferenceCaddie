import { ExternalLink } from 'lucide-preact';
import type { ThemePref } from '../lib/storage';
import { Segmented } from './common';

declare const __APP_VERSION__: string;

export function SettingsScreen({ theme, onTheme }: { theme: ThemePref; onTheme: (t: ThemePref) => void }) {
  return (
    <div class="settings">
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
    </div>
  );
}
