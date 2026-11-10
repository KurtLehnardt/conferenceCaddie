// Requests to talk shop: incoming cards with Accept / Not now / Block, and this device's own
// open requests. Reached from the People tab header; polls while open. Asks are now-only: each
// runs out 15 minutes after it was made, and accept opens the meet screen at once.
import { useState } from 'preact/hooks';
import { Inbox, MessageCircle } from 'lucide-preact';
import { OverflowMenu } from '../components/common';
import { meetAction, PeopleApiError } from './api';
import { blockWithConfirm, dropIncoming, getInbox, OPEN_STATES, setIncomingState, useInboxWatch } from './connect';
import { usePeopleStore } from './storage';
import type { ConferenceLike, InboxIncoming } from './types';
import { toast } from './ui';

export const RAN_OUT_COPY = 'That ask has run out.';

/** "Expires in N min" for an ask, or null when the time is unknown. */
export function expiresIn(expiresAt: string | null | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return null;
  return `Expires in ${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

function IncomingCard({ slug, request }: { slug: string; request: InboxIncoming }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = request.from.display_name;
  const waiting = request.state === 'requested';
  // Only the zone the server sends: it is cleared once the two no longer share a zone or either
  // presence ends, so the card never claims the asker is in the reader's zone after they moved.
  const zone = request.same_zone ? (request.other?.zone ?? null) : null;
  const hint = waiting ? expiresIn(request.expires_at) : null;

  const act = async (action: 'accept' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      const res = await meetAction(request.meet_id, action);
      if (action === 'accept') {
        setIncomingState(slug, request.meet_id, res.state ?? 'active');
        location.hash = `#/meet/${encodeURIComponent(request.meet_id)}`;
      } else {
        dropIncoming(slug, request.meet_id);
      }
    } catch (err) {
      if (err instanceof PeopleApiError && (err.status === 404 || err.status === 410)) {
        dropIncoming(slug, request.meet_id);
        if (action === 'accept') toast(RAN_OUT_COPY);
      } else setError(err instanceof PeopleApiError ? err.message : 'That could not be saved. Please try again.');
    }
    setBusy(false);
  };

  return (
    <article class="pp-person pp-inbox-card">
      <header class="pp-person-head">
        <h3 class="pp-person-name">
          {zone ? (
            <>
              {name} is in {zone} with you and would like to talk shop.
            </>
          ) : request.topic_label ? (
            <>
              {name} would like to talk shop about {request.topic_label}.
            </>
          ) : (
            <>{name} would like to talk shop.</>
          )}
        </h3>
        <span class="pp-person-menu">
          <OverflowMenu
            label={`Options for ${name}`}
            items={[
              {
                label: 'Block',
                destructive: true,
                onSelect: () => blockWithConfirm(slug, { ref: request.from.ref, display_name: name }, () => dropIncoming(slug, request.meet_id)),
              },
            ]}
          />
        </span>
      </header>
      {request.from.about && <p class="pp-person-about">{request.from.about}</p>}
      {request.note && (
        <p class="pp-opener">
          <MessageCircle size={18} aria-hidden="true" />
          <span>{request.note}</span>
        </p>
      )}
      {error && <p class="pp-error">{error}</p>}
      <div class="pp-actions pp-person-actions">
        {waiting ? (
          <>
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={() => act('accept')}>
              Accept
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => act('decline')}>
              Not now
            </button>
            {hint && <span class="pp-hint pp-expires">{hint}</span>}
          </>
        ) : (
          <a class="btn btn-tonal btn-small" href={`#/meet/${encodeURIComponent(request.meet_id)}`}>
            Open meet-up
          </a>
        )}
      </div>
    </article>
  );
}

export function InboxScreen({ conference }: { conference: ConferenceLike }) {
  usePeopleStore();
  const slug = conference.slug;
  useInboxWatch(slug, true);
  const inbox = getInbox(slug);
  const incoming = inbox.incoming.filter((r) => OPEN_STATES.includes(r.state));
  const outgoing = inbox.outgoing.filter((r) => OPEN_STATES.includes(r.state));

  return (
    <div class="pp-screen">
      <section class="pp-section" aria-labelledby="pp-inbox-title">
        <div class="pp-section-head">
          <h2 id="pp-inbox-title" class="pp-section-title">
            Requests
          </h2>
        </div>
        {!inbox.loaded && <p class="pp-hint pp-pad">Checking…</p>}
        {inbox.loaded && incoming.length === 0 && (
          <div class="pp-prompt">
            <Inbox size={22} aria-hidden="true" class="pp-prompt-icon" />
            <div>
              <p class="pp-prompt-title">No requests yet</p>
              <p class="pp-prompt-body">When someone asks to talk shop, it shows up here while you have the app open.</p>
            </div>
          </div>
        )}
        {incoming.length > 0 && (
          <div class="pp-list">
            {incoming.map((r) => (
              <IncomingCard key={r.meet_id} slug={slug} request={r} />
            ))}
          </div>
        )}
      </section>
      {outgoing.length > 0 && (
        <section class="pp-section" aria-labelledby="pp-outgoing-title">
          <div class="pp-section-head">
            <h2 id="pp-outgoing-title" class="pp-section-title">
              Your requests
            </h2>
          </div>
          <ul class="pp-outgoing" role="list">
            {outgoing.map((r) => (
              <li key={r.meet_id} class="pp-outgoing-row">
                <span class="pp-outgoing-name">{r.to.display_name}</span>
                {r.state === 'requested' ? (
                  <span class="pp-hint">No reply yet</span>
                ) : (
                  <a class="btn btn-tonal btn-small" href={`#/meet/${encodeURIComponent(r.meet_id)}`}>
                    Open meet-up
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
