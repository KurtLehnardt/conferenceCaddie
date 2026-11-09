// The one nudge banner at the top of the People tab, and the Settings switch that controls it.
// The banner states only what the spec allows before the tap: the evidence and the zone. Never a
// name, never a distance.
import { Sparkles, X } from 'lucide-preact';
import { dismissNudge, NUDGE_SETTING_LABEL, nudgesEnabled, seeWho, setNudgesEnabled, useNudges } from './nudges';
import { usePeopleStore } from './storage';
import type { ConferenceLike } from './types';

export function NudgeBanner({ conference }: { conference: ConferenceLike }) {
  const { nudge } = useNudges(conference.slug);
  if (!nudge) return null;
  return (
    <div class="pp-banner pp-nudge" role="region" aria-label="Someone to meet">
      <div class="pp-banner-row">
        <Sparkles size={20} aria-hidden="true" class="pp-banner-icon" />
        <p class="pp-banner-text">{nudge.text}</p>
        <button type="button" class="icon-btn" aria-label="Dismiss" onClick={dismissNudge}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div class="pp-actions pp-banner-actions">
        <button type="button" class="btn btn-tonal btn-small" onClick={() => seeWho(nudge)}>
          See who
        </button>
      </div>
    </div>
  );
}

/** Settings: "Nudge me when a strong match is in my zone", on by default, stored on the device. */
export function NudgeSetting({ conference }: { conference: ConferenceLike }) {
  usePeopleStore();
  const slug = conference.slug;
  return (
    <section class="settings-group" aria-labelledby="set-nudges">
      <h2 class="settings-heading" id="set-nudges">
        Nudges
      </h2>
      <div class="settings-card">
        <label class="settings-row pp-switch-row">
          <span>{NUDGE_SETTING_LABEL}</span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={nudgesEnabled(slug)}
            onChange={(e) => setNudgesEnabled(slug, (e.target as HTMLInputElement).checked)}
          />
        </label>
        <p class="settings-row settings-text">
          While you're around, one banner on the People tab when someone with specific, matching experience is in your
          zone, or someone you're watching turns up anywhere. Once per person per day. Nothing is sent to your phone.
        </p>
      </div>
    </section>
  );
}
