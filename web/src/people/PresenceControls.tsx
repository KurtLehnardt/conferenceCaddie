// The "I'm around" switch on the People tab: zone picker, optional spot line, the first-time
// notice, the remaining time (tap extends), the #/here/{zone} deep link, and under it the push
// nudge switch (PushControls).
import { useEffect, useRef, useState } from 'preact/hooks';
import { MapPin } from 'lucide-preact';
import {
  extend,
  lastChosenZone,
  matchZone,
  minutesLeft,
  PRESENCE_NOTICE,
  turnOff,
  turnOn,
  useMinuteTick,
  useZones,
  zonesFor,
} from './presence';
import { PushSwitch } from './PushControls';
import { getPresence, getProfile, getVisibility, usePeopleStore } from './storage';
import type { ConferenceLike, InterestedProp } from './types';
import { toast } from './ui';
import { interestedTalks } from './util';

export const PRESENCE_LABEL = 'Around and up for a conversation (while the app is open)';
const SPOT_MAX = 60;

export function ZoneSelect({
  id,
  zones,
  value,
  onChange,
  label,
}: {
  id: string;
  zones: string[];
  value: string;
  onChange: (zone: string) => void;
  label: string;
}) {
  return (
    <div class="pp-text">
      <label class="pp-label" for={id}>
        {label}
      </label>
      <select id={id} class="pp-select" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PresenceControls({
  conference,
  interested,
  deepLink,
  onDeepLinkHandled,
}: {
  conference: ConferenceLike;
  interested: InterestedProp;
  /** The raw zone from #/here/{zone}, handled once and then cleared by the shell. */
  deepLink?: string | null;
  onDeepLinkHandled?: () => void;
}) {
  usePeopleStore();
  const slug = conference.slug;
  const presence = getPresence(slug);
  const talks = interestedTalks(interested);
  const zones = useZones(slug, talks);
  useMinuteTick(presence.on);
  const [panel, setPanel] = useState(false);
  const [zone, setZone] = useState('');
  const [spot, setSpot] = useState(presence.spot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownZone, setUnknownZone] = useState(false);
  const handled = useRef<string | null>(null);

  const visible = getVisibility(slug).open_to_meet && !!getProfile()?.display_name.trim();

  const openPanel = (preset: string | null) => {
    setZone(preset ?? presence.zone ?? lastChosenZone() ?? zones[0] ?? '');
    setSpot(getPresence(slug).spot);
    setError(null);
    setPanel(true);
  };

  // #/here/{zone}: a known zone turns presence on at once (after the notice, the first time);
  // anything else opens the picker.
  useEffect(() => {
    if (!deepLink || handled.current === deepLink) return;
    handled.current = deepLink;
    let live = true;
    zonesFor(slug, talks).then(async (all) => {
      if (!live) return;
      const match = matchZone(all, deepLink);
      const p = getPresence(slug);
      if (match && p.notice_seen) {
        setBusy(true);
        const err = await turnOn(slug, match, p.spot);
        setBusy(false);
        if (err) {
          setError(err);
          openPanel(match);
        }
      } else {
        setUnknownZone(!match);
        openPanel(match);
      }
      onDeepLinkHandled?.();
    });
    return () => {
      live = false;
    };
  }, [deepLink, slug]);

  const apply = async () => {
    const z = zone || zones[0];
    if (!z) return;
    setBusy(true);
    setError(null);
    const err = await turnOn(slug, z, spot);
    setBusy(false);
    if (err) setError(err);
    else {
      setPanel(false);
      setUnknownZone(false);
    }
  };

  // The switch shows on while the zone is being picked; "Not now" or a second tap puts it back.
  const onSwitch = (on: boolean) => {
    if (on) openPanel(null);
    else {
      setPanel(false);
      if (presence.on) void turnOff(slug);
    }
  };

  const onExtend = async () => {
    setBusy(true);
    const err = await extend(slug);
    setBusy(false);
    if (err) setError(err);
    else toast('Extended for another hour');
  };

  return (
    <section class="pp-card pp-presence" aria-label="I'm around">
      <label class="pp-switch-row">
        <span>{PRESENCE_LABEL}</span>
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={presence.on || panel}
          disabled={busy}
          onChange={(e) => onSwitch((e.target as HTMLInputElement).checked)}
        />
      </label>
      <PushSwitch slug={slug} variant="card" />
      {presence.on && presence.zone && (
        <div class="pp-presence-on">
          <p class="pp-around">
            <MapPin size={16} aria-hidden="true" />
            {presence.zone}
            {presence.spot && ` · ${presence.spot}`}
          </p>
          <div class="pp-actions">
            <button type="button" class="btn btn-tonal btn-small" disabled={busy} onClick={onExtend}>
              Turns off in {minutesLeft(presence.until)} min · Extend
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => openPanel(null)}>
              Change zone
            </button>
          </div>
        </div>
      )}
      {panel && (
        <div class="pp-presence-setup">
          {!presence.notice_seen && (
            <div class="pp-notice" role="region" aria-label="About being around">
              <p>{PRESENCE_NOTICE}</p>
            </div>
          )}
          {unknownZone && <p class="pp-hint">That zone isn't on this conference's list. Pick one below.</p>}
          {!visible && (
            <p class="pp-hint">
              Being around needs a visible profile.{' '}
              <a class="pp-inline-link" href="#/profile">
                Open my profile
              </a>
            </p>
          )}
          <ZoneSelect id="pp-zone" label="Zone" zones={zones} value={zone || zones[0] || ''} onChange={setZone} />
          <div class="pp-text">
            <label class="pp-label" for="pp-spot">
              Where in the zone (optional)
            </label>
            <input
              id="pp-spot"
              type="text"
              autocomplete="off"
              maxLength={SPOT_MAX}
              value={spot}
              placeholder="For example: by the coffee cart"
              aria-invalid={error ? true : undefined}
              aria-describedby="pp-spot-hint"
              onInput={(e) => {
                setSpot((e.target as HTMLInputElement).value);
                if (error) setError(null);
              }}
            />
            <p id="pp-spot-hint" class={error ? 'pp-error' : 'pp-hint'}>
              {error ?? 'Shared only with people who can also see you, while this is on.'}
              {error?.includes('profile') && (
                <>
                  {' '}
                  <a class="pp-inline-link" href="#/profile">
                    Open my profile
                  </a>
                </>
              )}
            </p>
          </div>
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={apply}>
              {busy ? 'Saving…' : presence.on ? 'Save' : "I'm around"}
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => setPanel(false)}>
              {presence.on ? 'Cancel' : 'Not now'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
