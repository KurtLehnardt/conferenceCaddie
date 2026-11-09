// One place to share, or stop sharing, the profile for every talk on the Interested list, and
// to let sharing follow the list from then on. Sits at the top of the Interested screen.
import { useState } from 'preact/hooks';
import { Users } from 'lucide-preact';
import { getVisibility, setVisibility, usePeopleStore } from './storage';
import { MAX_SHARED_TALKS, shareForTalks, unshareAll } from './sync';
import type { ConferenceLike, InterestedProp } from './types';
import { interestedIds, SHARE_NOTICE } from './util';

export function ShareAllControls({ conference, interested }: { conference: ConferenceLike; interested: InterestedProp }) {
  usePeopleStore();
  const slug = conference.slug;
  const vis = getVisibility(slug);
  const ids = interestedIds(interested);
  const sharedHere = ids.filter((id) => vis.shared_talk_ids.includes(id)).length;
  const allShared = ids.length > 0 && sharedHere === ids.length;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'all' | 'follow' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!ids.length) return null;

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    const err = await fn();
    setBusy(false);
    setNotice(null);
    if (err) setMessage(err);
  };

  const shareAll = () => run(() => shareForTalks(slug, ids));
  const stopAll = () => run(() => unshareAll(slug));
  const followOn = () =>
    run(async () => {
      setVisibility(slug, { share_new: true, share_notice_seen: true });
      // Turning it on also catches up: everything already marked is shared.
      return shareForTalks(slug, ids);
    });

  const onShareAll = () => (vis.share_notice_seen ? void shareAll() : setNotice('all'));
  const onFollow = (on: boolean) => {
    if (!on) {
      setVisibility(slug, { share_new: false });
      return;
    }
    if (vis.share_notice_seen) void followOn();
    else setNotice('follow');
  };

  const summary =
    sharedHere === 0
      ? `Your profile is not shared for any of these ${ids.length} talks.`
      : allShared
        ? `Your profile is shared for all ${ids.length} talks here.`
        : `Your profile is shared for ${sharedHere} of these ${ids.length} talks.`;

  return (
    <section class="pp-card pp-share-all" aria-labelledby="pp-share-all-h">
      <h2 id="pp-share-all-h" class="pp-card-title">
        Share with people interested in these talks
      </h2>
      <p class="pp-count">
        <Users size={16} aria-hidden="true" />
        {summary}
      </p>
      <div class="pp-actions">
        {!allShared && (
          <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={onShareAll}>
            Share for all {ids.length > MAX_SHARED_TALKS ? MAX_SHARED_TALKS : ids.length}
          </button>
        )}
        {vis.shared_talk_ids.length > 0 && (
          <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={stopAll}>
            Stop sharing for all
          </button>
        )}
      </div>
      <label class="pp-switch-row">
        <span>Share automatically for talks I mark, and stop when I unmark</span>
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={vis.share_new}
          disabled={busy}
          onChange={(e) => onFollow((e.target as HTMLInputElement).checked)}
        />
      </label>
      {notice && (
        <div class="pp-notice" role="region" aria-label="About sharing">
          <p>{SHARE_NOTICE}</p>
          <div class="pp-actions">
            <button
              type="button"
              class="btn btn-primary btn-small"
              disabled={busy}
              onClick={() => void (notice === 'all' ? shareAll() : followOn())}
            >
              Share my profile
            </button>
            <button type="button" class="btn btn-text btn-small" onClick={() => setNotice(null)}>
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
    </section>
  );
}
