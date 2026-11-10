// The meet screen (#/meet/{id}): the rendezvous, their zone and spot, how to spot them, my own
// how-to-spot-me line, then, only when the server sent one, the distance (and an arrow once the
// compass is allowed), then "We found each other" / "Cancel". Polls every 10 s while open. The
// other person's card has Report in its overflow menu (the meet-up) and on their spot line.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Check, MapPin, MessageCircle } from 'lucide-preact';
import { OverflowMenu } from '../components/common';
import { errorField, fetchMeet, isAbort, meetAction, PeopleApiError, putMeetDetails } from './api';
import { personForMeet, refreshInbox } from './connect';
import { useZones } from './presence';
import { ZoneSelect } from './PresenceControls';
import { ReportSheet, type ReportTarget } from './ReportSheet';
import { addMet, getPresence, usePeopleStore } from './storage';
import type { ConferenceLike, InterestedProp, MeetDetail } from './types';
import { confirm, toast } from './ui';
import { interestedTalks, Marked } from './util';

export const MEET_CAVEAT = 'Positions indoors are rough. Head to the meeting point and look for them.';
export const MEET_POLL_MS = 10_000;
const SPOT_ME_MAX = 60;

/** "About 120 m", from the server's distance (already rounded to 10 m). */
export function distanceText(m: number): string {
  return m < 10 ? 'Less than 10 m away' : `About ${m} m`;
}

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };
type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

/** The compass heading of an orientation event, degrees clockwise from north, or null. */
function headingOf(e: CompassEvent): number | null {
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) return e.webkitCompassHeading;
  if (e.absolute && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) return (360 - e.alpha) % 360;
  return null;
}

/**
 * The distance to the other person and, after a tap that asks for the compass (iOS needs
 * DeviceOrientationEvent.requestPermission on a user gesture), an arrow turned by
 * bearing minus heading. Without permission or a heading there is only the distance.
 */
function Distance({ distance, bearing }: { distance: number; bearing: number }) {
  const [heading, setHeading] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState(false);
  const hasCompass = typeof DeviceOrientationEvent !== 'undefined';

  useEffect(() => {
    if (!listening) return;
    const onOrientation = (e: Event) => {
      const h = headingOf(e as CompassEvent);
      if (h !== null) setHeading(h);
    };
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(type, onOrientation);
    return () => window.removeEventListener(type, onOrientation);
  }, [listening]);

  const pointMe = async () => {
    const ctor = DeviceOrientationEvent as OrientationCtor;
    if (typeof ctor.requestPermission === 'function') {
      try {
        if ((await ctor.requestPermission()) !== 'granted') {
          setRefused(true);
          return;
        }
      } catch {
        setRefused(true);
        return;
      }
    }
    setListening(true);
  };

  const turn = heading === null ? null : (((bearing - heading) % 360) + 360) % 360;
  return (
    <section class="pp-card pp-distance" aria-labelledby="pp-dist-h">
      <h2 id="pp-dist-h" class="pp-card-title">
        {distanceText(distance)}
      </h2>
      {turn !== null ? (
        <p class="pp-arrow" role="img" aria-label={`They're ${Math.round(turn)} degrees to your right of straight ahead`}>
          <ArrowUp size={36} aria-hidden="true" style={{ transform: `rotate(${turn}deg)` }} />
        </p>
      ) : listening ? (
        <p class="pp-hint">Waiting for the compass… hold the phone flat.</p>
      ) : hasCompass && !refused ? (
        <button type="button" class="btn btn-tonal btn-small pp-self-start" onClick={() => void pointMe()}>
          Point me
        </button>
      ) : null}
    </section>
  );
}

type View =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; over: boolean }
  | { kind: 'live'; detail: MeetDetail }
  | { kind: 'found'; name: string; about: string | null }
  | { kind: 'cancelled' };

function problem(err: unknown): { message: string; over: boolean } {
  if (err instanceof PeopleApiError) {
    if (err.status === 410) return { message: 'This meet-up is over.', over: true };
    if (err.status === 404) return { message: "This meet-up couldn't be found.", over: true };
    if (err.status === 403) return { message: "This meet-up isn't yours to see.", over: true };
    return { message: err.message, over: false };
  }
  return { message: 'This is unavailable right now. Please try again.', over: false };
}

export function MeetScreen({
  conference,
  meetId,
  interested,
}: {
  conference: ConferenceLike;
  meetId: string;
  interested: InterestedProp;
}) {
  usePeopleStore();
  const slug = conference.slug;
  const zones = useZones(slug, interestedTalks(interested));
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [spotMe, setSpotMe] = useState('');
  const [spotSaved, setSpotSaved] = useState(false);
  const [spotError, setSpotError] = useState<string | null>(null);
  const [rendezvous, setRendezvous] = useState('');
  const [pickingSpot, setPickingSpot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const seededSpot = useRef(false);
  const stop = useRef(false);
  // The last open meet this screen showed, for the found view when the other person ends it.
  const lastLive = useRef<MeetDetail | null>(null);

  const foundView = (d: MeetDetail): View => ({ kind: 'found', name: d.other.display_name, about: d.other.about ?? personForMeet(meetId)?.about ?? null });

  const load = async (signal?: AbortSignal) => {
    try {
      const d = await fetchMeet(meetId, signal);
      if (signal?.aborted || stop.current) return;
      lastLive.current = d;
      setView({ kind: 'live', detail: d });
      if (!seededSpot.current && d.mine?.spot_me) {
        seededSpot.current = true;
        setSpotMe(d.mine.spot_me);
      }
      if (d.rendezvous) setRendezvous(d.rendezvous);
      // The other side ended it, or it ran out.
      if (d.state === 'found') setView(foundView(d));
      else if (d.state === 'cancelled' || d.state === 'declined' || d.state === 'expired') {
        setView({ kind: 'error', message: d.state === 'declined' ? 'They said not now.' : 'This meet-up is over.', over: true });
      }
    } catch (err) {
      if (isAbort(err) || stop.current) return;
      // A meet this screen was showing ended on the other phone: 410 says how. They tapped "We
      // found each other", so this side gets the found view too; or they cancelled it.
      const ended = err instanceof PeopleApiError && err.status === 410 ? errorField(err, 'state') : null;
      const live = lastLive.current;
      if (live && (ended === 'found' || ended === 'cancelled')) {
        end();
        setView(ended === 'found' ? foundView(live) : { kind: 'error', message: `${live.other.display_name || 'They'} cancelled the meet-up.`, over: true });
        return;
      }
      setView((v) => (v.kind === 'live' && !(err instanceof PeopleApiError && err.status >= 400 && err.status < 500) ? v : { kind: 'error', ...problem(err) }));
    }
  };

  useEffect(() => {
    stop.current = false;
    const ctl = new AbortController();
    void load(ctl.signal);
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState !== 'hidden' && !stop.current) void load(ctl.signal);
      timer = window.setTimeout(tick, MEET_POLL_MS);
    };
    timer = window.setTimeout(tick, MEET_POLL_MS);
    return () => {
      ctl.abort();
      window.clearTimeout(timer);
    };
  }, [meetId]);

  // Lists elsewhere learn the new state on their next poll; this nudges them now.
  const end = () => {
    stop.current = true;
    void refreshInbox(slug);
  };

  const found = async () => {
    if (view.kind !== 'live') return;
    setBusy(true);
    try {
      await meetAction(meetId, 'found');
      end();
      setView(foundView(view.detail));
    } catch (err) {
      const p = problem(err);
      if (p.over) {
        end();
        setView(foundView(view.detail));
      } else toast(p.message);
    }
    setBusy(false);
  };

  const cancel = () =>
    confirm({
      title: 'Cancel this meet-up?',
      body: "They'll see that it ended. You can ask again later.",
      confirmLabel: 'Cancel meet-up',
      onConfirm: () => {
        setBusy(true);
        meetAction(meetId, 'cancel')
          .then(() => {
            end();
            setView({ kind: 'cancelled' });
          })
          .catch((err) => {
            const p = problem(err);
            if (p.over) {
              end();
              setView({ kind: 'cancelled' });
            } else toast(p.message);
          })
          .finally(() => setBusy(false));
      },
    });

  const saveSpotMe = async () => {
    setBusy(true);
    setSpotError(null);
    try {
      await putMeetDetails(meetId, { spot_me: spotMe.trim().slice(0, SPOT_ME_MAX) });
      setSpotSaved(true);
    } catch (err) {
      setSpotError(err instanceof PeopleApiError ? err.message : 'That could not be saved. Please try again.');
    }
    setBusy(false);
  };

  const setMeetingPoint = async (zone: string) => {
    setBusy(true);
    try {
      await putMeetDetails(meetId, { rendezvous: zone });
      setRendezvous(zone);
      setPickingSpot(false);
      if (view.kind === 'live') setView({ kind: 'live', detail: { ...view.detail, rendezvous: zone } });
    } catch (err) {
      toast(err instanceof PeopleApiError ? err.message : 'That could not be saved. Please try again.');
    }
    setBusy(false);
  };

  if (view.kind === 'loading') return <p class="pp-hint pp-pad pp-screen">Checking…</p>;

  if (view.kind === 'error') {
    return (
      <div class="pp-screen">
        <div class="pp-prompt">
          <div>
            <p class="pp-prompt-title">{view.message}</p>
            <a class="btn btn-tonal btn-small pp-prompt-btn" href="#/people">
              Back to People
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'cancelled') {
    return (
      <div class="pp-screen">
        <div class="pp-prompt">
          <div>
            <p class="pp-prompt-title">Meet-up cancelled</p>
            <a class="btn btn-tonal btn-small pp-prompt-btn" href="#/people">
              Back to People
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'found') {
    const person = personForMeet(meetId);
    const opener = person?.opener || person?.reasons?.[0] || null;
    return (
      <div class="pp-screen">
        <section class="pp-card pp-found" aria-labelledby="pp-found-h">
          <h2 id="pp-found-h" class="pp-card-title">
            You found {view.name}
          </h2>
          {opener ? (
            <p class="pp-opener">
              <MessageCircle size={18} aria-hidden="true" />
              <span>
                <Marked text={opener} />
              </span>
            </p>
          ) : (
            <p class="pp-hint">Compare notes, then swap a way to stay in touch if it went well.</p>
          )}
          <div class="pp-actions">
            {saved ? (
              <span class="pp-hint pp-asked" role="status">
                <Check size={16} aria-hidden="true" /> Saved under Settings
              </span>
            ) : (
              <button
                type="button"
                class="btn btn-primary btn-small"
                onClick={() => {
                  addMet(slug, { display_name: view.name, about: view.about ?? person?.about ?? '' });
                  setSaved(true);
                  toast('Saved. Find them under Settings › People I met.');
                }}
              >
                Save this person
              </button>
            )}
            <a class="btn btn-text btn-small" href="#/people">
              Back to People
            </a>
          </div>
        </section>
      </div>
    );
  }

  const d = view.detail;
  const name = d.other.display_name;
  const active = d.state === 'active';
  const minutes = d.active_until ? Math.max(0, Math.ceil((Date.parse(d.active_until) - Date.now()) / 60_000)) : null;
  // Reports name the other person by their ref, which the server sends with the meet.
  const otherRef = d.other.ref ?? null;
  const report = (kind: 'meet' | 'spot') => {
    if (otherRef) setReporting({ ref: otherRef, display_name: name, kind, id: kind === 'meet' ? meetId : otherRef });
  };
  // Same zone: they are already next to each other, so how to spot each other comes first and
  // the meeting point is optional.
  const sameZone = d.same_zone === true;
  const sharedZone = sameZone ? (d.other.zone ?? d.rendezvous ?? getPresence(slug).zone) : null;

  const rendezvousCard = (
    <section class="pp-card" aria-labelledby="pp-rv-h">
      <h2 id="pp-rv-h" class="pp-card-title">
        {d.rendezvous ? `Meet at ${d.rendezvous}` : sameZone ? 'Meeting point (optional)' : 'No meeting point yet'}
      </h2>
      {!pickingSpot ? (
        <button type="button" class="btn btn-tonal btn-small pp-self-start" disabled={busy} onClick={() => setPickingSpot(true)}>
          {d.rendezvous ? 'Change meeting point' : 'Set a meeting point'}
        </button>
      ) : (
        <>
          <ZoneSelect id="pp-rv-zone" label="Meeting point" zones={zones} value={rendezvous || d.other.zone || zones[0] || ''} onChange={setRendezvous} />
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => setMeetingPoint(rendezvous || d.other.zone || zones[0])}>
              Set
            </button>
            <button type="button" class="btn btn-text btn-small" onClick={() => setPickingSpot(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );

  const themCard = (
    <section class="pp-card" aria-labelledby="pp-them-h">
      <header class="pp-person-head">
        <h2 id="pp-them-h" class="pp-card-title">
          {name}
        </h2>
        {otherRef && (
          <span class="pp-person-menu">
            <OverflowMenu label={`Options for ${name}`} items={[{ label: 'Report', onSelect: () => report('meet') }]} />
          </span>
        )}
      </header>
      {d.other.zone ? (
        <p class="pp-around">
          <MapPin size={16} aria-hidden="true" />
          {d.other.zone}
          {d.other.spot && ` · ${d.other.spot}`}
          {d.other.spot && otherRef && (
            <button type="button" class="btn btn-text btn-small pp-spot-report" onClick={() => report('spot')}>
              Report
            </button>
          )}
        </p>
      ) : (
        <p class="pp-hint">{active ? "They haven't said where they are." : `${name} isn't around right now.`}</p>
      )}
      <p class="pp-subhead">How to spot them</p>
      <p class={d.other.spot_me ? 'pp-spot-them' : 'pp-hint'}>{d.other.spot_me ?? "They haven't said how to spot them yet."}</p>
      {active && minutes !== null && <p class="pp-hint">About {minutes} min left.</p>}
    </section>
  );

  const meCard = (
    <section class="pp-card" aria-labelledby="pp-me-h">
      <h2 id="pp-me-h" class="pp-card-title">
        How to spot me
      </h2>
      {sameZone && !spotMe && <p class="pp-hint">Add a line so {name} can find you.</p>}
      <div class="pp-text">
        <label class="pp-label" for="pp-spot-me">
          One line they'll see only until you meet
        </label>
        <input
          id="pp-spot-me"
          type="text"
          autocomplete="off"
          maxLength={SPOT_ME_MAX}
          value={spotMe}
          placeholder="For example: green hoodie, grey backpack"
          aria-invalid={spotError ? true : undefined}
          aria-describedby="pp-spot-me-hint"
          onInput={(e) => {
            setSpotMe((e.target as HTMLInputElement).value);
            setSpotSaved(false);
            if (spotError) setSpotError(null);
          }}
        />
        <p id="pp-spot-me-hint" class={spotError ? 'pp-error' : 'pp-hint'}>
          {spotError ?? (spotSaved ? 'Saved' : `${spotMe.length} of ${SPOT_ME_MAX}`)}
        </p>
      </div>
      <button type="button" class="btn btn-tonal btn-small pp-self-start" disabled={busy || spotSaved} onClick={saveSpotMe}>
        Save
      </button>
    </section>
  );

  return (
    <div class="pp-screen pp-meet">
      {d.state === 'requested' && (
        <p class="pp-lede">
          Waiting for {name}. <span class="pp-hint">No reply yet.</span>
        </p>
      )}
      {sameZone && sharedZone && active && (
        <p class="pp-lede pp-same-zone" role="status">
          You're both in {sharedZone}.
        </p>
      )}

      {sameZone ? (
        <>
          {themCard}
          {meCard}
          {rendezvousCard}
        </>
      ) : (
        <>
          {rendezvousCard}
          {themCard}
          {meCard}
        </>
      )}

      {/* Below the meeting point, their zone and the spot-me lines, never above: a rough aid, not the plan. */}
      {active && typeof d.other.distance_m === 'number' && typeof d.other.bearing_deg === 'number' && (
        <Distance distance={d.other.distance_m} bearing={d.other.bearing_deg} />
      )}

      <p class="pp-lede pp-caveat">{MEET_CAVEAT}</p>
      <div class="pp-actions">
        <button type="button" class="btn btn-primary" disabled={busy} onClick={found}>
          We found each other
        </button>
        <button type="button" class="btn btn-text pp-danger" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {reporting && <ReportSheet slug={slug} target={reporting} onClose={() => setReporting(null)} />}
    </div>
  );
}
