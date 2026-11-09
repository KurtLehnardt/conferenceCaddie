// Settings sections for Find & connect: the people this device has blocked (refreshed from the
// server when Settings opens) and the device-only "People I met" list.
import { useEffect, useState } from 'preact/hooks';
import { fetchBlocks, isAbort } from './api';
import { unblock } from './connect';
import { getBlocks, getMet, mergeBlocks, removeMet, usePeopleStore } from './storage';
import type { ConferenceLike } from './types';

export function BlockedPeople({ conference }: { conference: ConferenceLike }) {
  usePeopleStore();
  const slug = conference.slug;
  const blocks = getBlocks(slug);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetchBlocks(slug, ctl.signal)
      .then((r) => !ctl.signal.aborted && Array.isArray(r.refs) && mergeBlocks(slug, r.refs.filter((x) => typeof x === 'string')))
      .catch((err) => {
        // No device yet, or offline: the cached list stands.
        if (!isAbort(err)) return;
      });
    return () => ctl.abort();
  }, [slug]);

  return (
    <section class="settings-group" aria-labelledby="set-blocked">
      <h2 class="settings-heading" id="set-blocked">
        Blocked people
      </h2>
      <div class="settings-card">
        {blocks.length === 0 ? (
          <p class="settings-row settings-text">Nobody is blocked at {conference.name}.</p>
        ) : (
          blocks.map((b) => (
            <div key={b.ref} class="settings-row">
              <span>{b.display_name ?? 'Someone you blocked'}</span>
              <button
                type="button"
                class="btn btn-text btn-small"
                disabled={busy === b.ref}
                onClick={async () => {
                  setBusy(b.ref);
                  setError(await unblock(slug, b.ref, b.display_name));
                  setBusy(null);
                }}
              >
                Unblock
              </button>
            </div>
          ))
        )}
        {error && <p class="settings-row pp-error">{error}</p>}
      </div>
    </section>
  );
}

export function PeopleIMet({ conference }: { conference: ConferenceLike }) {
  usePeopleStore();
  const slug = conference.slug;
  const met = getMet(slug);
  if (!met.length) return null;
  return (
    <section class="settings-group" aria-labelledby="set-met">
      <h2 class="settings-heading" id="set-met">
        People I met
      </h2>
      <div class="settings-card">
        {met.map((p, i) => (
          <div key={`${p.met_at}-${i}`} class="settings-row settings-row-stack pp-met-row">
            <div class="pp-met-text">
              <span class="pp-met-name">{p.display_name}</span>
              {p.about && <span class="settings-text">{p.about}</span>}
            </div>
            <button type="button" class="btn btn-text btn-small" onClick={() => removeMet(slug, i)}>
              Remove
            </button>
          </div>
        ))}
        <p class="settings-row settings-text">Saved on this phone only.</p>
      </div>
    </section>
  );
}
