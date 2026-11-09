// The people controls inside a talk card: the circle count, the separate
// "share my profile for this talk" choice, and the circle itself.
import { useEffect, useState } from 'preact/hooks';
import { ChevronDown, ChevronUp, ExternalLink, Users } from 'lucide-preact';
import { fetchCircleMembers, isAbort, PeopleApiError } from './api';
import { PersonCard } from './PersonCard';
import { getVisibility, setVisibility, usePeopleStore } from './storage';
import { changeVisibility, getSaveCount } from './sync';
import type { CircleMembers, ConferenceLike, InterestedProp, TalkLike } from './types';
import { interestedIds, invalidateCount, peopleCountLabel, useCircleCount } from './util';

export function CircleView({ conference, talkId }: { conference: ConferenceLike; talkId: string }) {
  const [data, setData] = useState<CircleMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsShare, setNeedsShare] = useState(false);
  const saves = getSaveCount();
  usePeopleStore();

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    fetchCircleMembers(conference.slug, talkId, ctl.signal)
      .then((d) => {
        setData(d);
        setNeedsShare(false);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        if (err instanceof PeopleApiError && (err.code === 'share_required' || err.code === 'no_device')) {
          setNeedsShare(true);
          // The server no longer holds this share, so the device forgets it too.
          const v = getVisibility(conference.slug);
          if (err.code === 'share_required' && v.shared_talk_ids.includes(talkId)) {
            setVisibility(conference.slug, { shared_talk_ids: v.shared_talk_ids.filter((i) => i !== talkId) });
          }
          return;
        }
        setError(err instanceof PeopleApiError ? err.message : 'This is unavailable right now.');
      });
    return () => ctl.abort();
  }, [conference.slug, talkId, saves]);

  if (needsShare) return <p class="pp-hint">Share your profile for this talk to see who else is interested.</p>;
  if (error) return <p class="pp-error">{error}</p>;
  if (!data) return <p class="pp-hint">Loading…</p>;

  const speakers = data.speakers ?? [];
  return (
    <div class="pp-circle">
      {speakers.length > 0 && (
        <>
          <h4 class="pp-subhead">Speakers</h4>
          <ul class="pp-speakers">
            {speakers.map((s, i) => (
              <li key={i} class="pp-speaker">
                <span class="pp-speaker-name">{s.name}</span>
                {s.tagline && <span class="pp-speaker-tagline">{s.tagline}</span>}
                {s.links?.length > 0 && (
                  <span class="pp-speaker-links">
                    {s.links
                      .filter((l) => /^https?:\/\//.test(l.url))
                      .slice(0, 4)
                      .map((l) => (
                        <a key={l.url} class="link" href={l.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink size={14} aria-hidden="true" />
                          {l.title || 'Link'}
                        </a>
                      ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 class="pp-subhead">Others who shared</h4>
      {data.members.length === 0 ? (
        <p class="pp-hint">No one else has shared yet. Check back later.</p>
      ) : (
        <div class="pp-list">
          {data.members.map((m) => (
            <PersonCard key={m.ref} person={m} />
          ))}
        </div>
      )}
    </div>
  );
}

const SHARE_NOTICE =
  'Sharing stores your profile on our server until the conference ends. Only people who also shared for this talk can see it, including How to reach me. Everyone else sees only the count. It does not make you visible conference-wide. Turn it off at any time to remove it.';

export function TalkPeopleControls({
  conference,
  talk,
  interested,
  circleCount,
  startOpen = false,
}: {
  conference: ConferenceLike;
  talk: TalkLike;
  interested: InterestedProp;
  circleCount?: number;
  startOpen?: boolean;
}) {
  usePeopleStore();
  const slug = conference.slug;
  const vis = getVisibility(slug);
  const shared = vis.shared_talk_ids.includes(talk.talk_id);
  const isInterested =
    typeof interested === 'boolean' ? interested : interestedIds(interested).includes(talk.talk_id);
  const count = useCircleCount(slug, talk.talk_id, circleCount);
  const [notice, setNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(startOpen);

  const apply = async (on: boolean) => {
    const ids = vis.shared_talk_ids.filter((i) => i !== talk.talk_id);
    if (on && ids.length >= 50) {
      setMessage('You can share for up to 50 talks. Turn one off first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const err = await changeVisibility(slug, {
      shared_talk_ids: on ? [...ids, talk.talk_id] : ids,
      ...(on ? { share_notice_seen: true } : {}),
    });
    setBusy(false);
    setNotice(false);
    if (err) setMessage(err);
    else {
      invalidateCount(slug, talk.talk_id);
      if (!on) setOpen(false);
    }
  };

  const onSwitch = (on: boolean) => {
    if (on && !vis.share_notice_seen) setNotice(true);
    else void apply(on);
  };

  const showToggle = isInterested || shared;
  if (!showToggle && !count) return null;

  return (
    <div class="pp-talk">
      {!!count && count > 0 && (
        <p class="pp-count">
          <Users size={16} aria-hidden="true" />
          {peopleCountLabel(count)}
        </p>
      )}
      {showToggle && (
        <label class="pp-switch-row">
          <span>Share my profile with others interested in this talk</span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={shared || notice}
            disabled={busy}
            onChange={(e) => onSwitch((e.target as HTMLInputElement).checked)}
          />
        </label>
      )}
      {notice && (
        <div class="pp-notice" role="region" aria-label="About sharing">
          <p>{SHARE_NOTICE}</p>
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => apply(true)}>
              Share my profile
            </button>
            <button type="button" class="btn btn-text btn-small" onClick={() => setNotice(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {message && (
        <p class="pp-error">
          {message}{' '}
          {message.includes('profile') && (
            <a class="pp-inline-link" href="#/profile">
              Open my profile
            </a>
          )}
        </p>
      )}
      {shared && (
        <button
          type="button"
          class="btn btn-tonal btn-small pp-see"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          See who's here
          {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
      )}
      {shared && open && <CircleView conference={conference} talkId={talk.talk_id} />}
    </div>
  );
}
