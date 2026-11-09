// The "I'm around" switch on the People tab: zone picker, duration ("For an hour" or "Until I
// turn it off today"), optional spot line, the first-time notice, the remaining time (tap
// extends), the optional "Use my position too" step once the zone is chosen, the push nudge
// switch (PushControls) under it, the #/here/{zone} deep link, and the "Still in {zone}?" row
// that the tab shows when the app comes back to the foreground with a zone that is more than ten
// minutes old.
import { useEffect, useRef, useState } from 'preact/hooks';
import { LocateFixed, MapPin, X } from 'lucide-preact';
import { BleControls } from './BleControls';
import {
  confirmZone,
  dismissZoneCheck,
  DURATION_LABELS,
  extend,
  geolocationAvailable,
  lastChosenZone,
  likelyZones,
  matchZone,
  minutesLeft,
  POSITION_EXPLAINER,
  POSITION_LABEL,
  PRESENCE_NOTICE,
  sharePosition,
  turnOff,
  turnOn,
  useMinuteTick,
  useZones,
  zonesFor,
} from './presence';
import { PushSwitch } from './PushControls';
import { getPresence, getProfile, getVisibility, usePeopleStore } from './storage';
import type { ConferenceLike, InterestedProp, PresenceMode } from './types';
import { toast } from './ui';
import { interestedTalks } from './util';

export const PRESENCE_LABEL = 'Around and up for a conversation';
export const DAY_HINT = "Stays on until you turn it off or the day ends. Whenever you come back to the app after a while, it asks whether you're still in the same zone.";
const SPOT_MAX = 60;
const LIKELY_ZONES = 4;

/**
 * "Still in {zone}?" with Yes, the likeliest other zones and "Other…" (the full picker). Shown at
 * the top of the People tab while a confirmation is pending; one tap confirms or moves the zone,
 * and closing the row counts as a confirmation.
 */
export function StillHereRow({ conference, interested }: { conference: ConferenceLike; interested: InterestedProp }) {
  usePeopleStore();
  const slug = conference.slug;
  const presence = getPresence(slug);
  const zones = useZones(slug, interestedTalks(interested));
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [other, setOther] = useState('');
  if (!presence.on || !presence.zone || !presence.confirm_pending) return null;
  const zone = presence.zone;
  const likely = likelyZones(slug, zones, LIKELY_ZONES);

  const answer = async (z: string) => {
    setBusy(true);
    const err = await confirmZone(slug, z);
    setBusy(false);
    if (err) toast(err);
    else {
      setPicking(false);
      if (z !== zone) toast(`Now in ${z}`);
    }
  };

  return (
    <div class="pp-still" role="region" aria-label="Still in the same zone?">
      <div class="pp-still-head">
        <p class="pp-still-title">Still in {zone}?</p>
        <button type="button" class="icon-btn" aria-label="Close" disabled={busy} onClick={() => dismissZoneCheck(slug)}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {!picking ? (
        <div class="pp-still-chips">
          <span class="chip is-active">
            <button type="button" class="chip-main" disabled={busy} onClick={() => void answer(zone)}>
              Yes
            </button>
          </span>
          {likely.map((z) => (
            <span key={z} class="chip">
              <button type="button" class="chip-main" disabled={busy} onClick={() => void answer(z)}>
                {z}
              </button>
            </span>
          ))}
          <span class="chip">
            <button
              type="button"
              class="chip-main"
              disabled={busy}
              onClick={() => {
                setOther(zones.find((z) => z !== zone && !likely.includes(z)) ?? zones[0] ?? '');
                setPicking(true);
              }}
            >
              Other…
            </button>
          </span>
        </div>
      ) : (
        <>
          <ZoneSelect id="pp-still-zone" label="Zone" zones={zones} value={other || zones[0] || ''} onChange={setOther} />
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => void answer(other || zones[0])}>
              I'm here
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => setPicking(false)}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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
  const [mode, setMode] = useState<PresenceMode>(presence.mode);
  const [spot, setSpot] = useState(presence.spot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownZone, setUnknownZone] = useState(false);
  const handled = useRef<string | null>(null);

  const visible = getVisibility(slug).open_to_meet && !!getProfile()?.display_name.trim();

  const openPanel = (preset: string | null) => {
    setZone(preset ?? presence.zone ?? lastChosenZone() ?? zones[0] ?? '');
    setSpot(getPresence(slug).spot);
    setMode(getPresence(slug).mode);
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
    const err = await turnOn(slug, z, spot, mode);
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

  // The optional step after the zone is chosen, shown once; the choice is kept on the device.
  const canLocate = geolocationAvailable();
  const askPosition = presence.on && !panel && canLocate && presence.position_choice === null;
  const choosePosition = async (on: boolean) => {
    setBusy(true);
    await sharePosition(slug, on);
    setBusy(false);
    if (on) toast('Using your position while you are around');
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
      {presence.on && presence.zone && (
        <div class="pp-presence-on">
          <p class="pp-around">
            <MapPin size={16} aria-hidden="true" />
            {presence.zone}
            {presence.spot && ` · ${presence.spot}`}
          </p>
          {presence.position && (
            <p class="pp-hint pp-position-on">
              <LocateFixed size={16} aria-hidden="true" />
              Using your position too
            </p>
          )}
          <div class="pp-actions">
            {presence.mode === 'day' ? (
              <span class="pp-hint pp-asked">On until you turn it off today</span>
            ) : (
              <button type="button" class="btn btn-tonal btn-small" disabled={busy} onClick={onExtend}>
                Turns off in {minutesLeft(presence.until)} min · Extend
              </button>
            )}
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => openPanel(null)}>
              Change zone
            </button>
            {canLocate && presence.position_choice !== null && (
              <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => void choosePosition(!presence.position)}>
                {presence.position ? 'Stop using position' : 'Use my position too'}
              </button>
            )}
          </div>
          {askPosition && (
            <div class="pp-notice pp-position-step" role="region" aria-label={POSITION_LABEL}>
              <p class="pp-subhead">{POSITION_LABEL}</p>
              <p>{POSITION_EXPLAINER}</p>
              <div class="pp-actions">
                <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => void choosePosition(true)}>
                  Use my position
                </button>
                <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => void choosePosition(false)}>
                  Zone only
                </button>
              </div>
            </div>
          )}
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
          <fieldset class="pp-duration">
            <legend class="pp-label">How long</legend>
            {(Object.keys(DURATION_LABELS) as PresenceMode[]).map((m) => (
              <label key={m} class="pp-radio">
                <input type="radio" name="pp-duration" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <span>{DURATION_LABELS[m]}</span>
              </label>
            ))}
            {mode === 'day' && <p class="pp-hint">{DAY_HINT}</p>}
          </fieldset>
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
      {/* Under the zone, duration and position: the push nudge switch, then (Android app only) Bluetooth. */}
      <PushSwitch slug={slug} variant="card" />
      <BleControls conference={conference} />
    </section>
  );
}
