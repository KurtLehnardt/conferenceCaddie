// The profile editor. The profile lives on this device and reaches the server only
// while the user is visible conference-wide or shares for a talk.
import { useState } from 'preact/hooks';
import { EyeOff, Trash2, TriangleAlert } from 'lucide-preact';
import { ImportGitHub, mergeGithubImport } from './ImportGitHub';
import { VISIBILITY_NOTICE } from './PeopleScreen';
import {
  EMPTY_PROFILE,
  getDeleteAll,
  getProfile,
  getVisibility,
  setProfile,
  slugsDeletePending,
  topicsFor,
  usePeopleStore,
} from './storage';
import {
  canStopTrying,
  changeVisibility,
  deleteMyProfile,
  finishPendingDeletes,
  getPendingDeleteDetail,
  getSyncStatus,
  LINKEDIN_RE,
  scheduleProfileSync,
  stopTrying,
  unshareAll,
} from './sync';
import { TopicPicker } from './TopicPicker';
import type { ConferenceLike, InterestedProp, Profile, TopicRef } from './types';
import { interestedIds } from './util';

/** Under both free-text fields: specific words are what the people search matches on. */
export const SPECIFIC_HINT = 'The more specific, the better the matches.';

/** Under the "Hidden after reports" heading for the owner of a profile two people reported. */
export const HIDDEN_COPY = 'Other attendees cannot see your profile, and you cannot ask to talk shop, until we have looked at it.';

function TextField({
  id,
  label,
  value,
  max,
  multiline,
  placeholder,
  hint,
  type = 'text',
  invalid,
  onInput,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'url';
  invalid?: string | null;
  onInput: (v: string) => void;
}) {
  const props = {
    id,
    value,
    maxLength: max,
    placeholder,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': invalid || hint ? `${id}-hint` : undefined,
    onInput: (e: Event) => onInput((e.target as HTMLInputElement).value),
  };
  return (
    <div class="pp-text">
      <label class="pp-label" for={id}>
        {label}
      </label>
      {multiline ? <textarea rows={3} {...props} /> : <input type="text" inputMode={type === 'url' ? 'url' : 'text'} autocomplete="off" {...props} />}
      {(invalid || hint) && (
        <p id={`${id}-hint`} class={invalid ? 'pp-error' : 'pp-hint'}>
          {invalid || hint}
        </p>
      )}
    </div>
  );
}

function SaveStatus() {
  const s = getSyncStatus();
  if (s.state === 'saving') return <p class="pp-status">Saving…</p>;
  if (s.state === 'error') return <p class="pp-status pp-error">{s.message ?? 'Could not save.'}</p>;
  if (s.state === 'saved') return <p class="pp-status">Saved</p>;
  return null;
}

/** Explains the notice for a delete the server has not confirmed yet. */
export const PENDING_DELETE_COPY = 'The app will not share your profile while the delete is unfinished, and it tries again by itself.';

/** Opens that explanation when a delete may have done part of its work. */
export const PENDING_HIDDEN_COPY = 'It may already be hidden from other attendees.';

/** Offered once the server has refused this device's key three times in a row. */
export const STOP_TRYING_COPY = "Our server keeps refusing this device's key, so trying again will not help.";

/** What stopping does, after "Delete my profile" and after turning visibility off. */
export const STOP_ALL_COPY = 'If you stop, your profile is deleted from this phone only; anything our server still holds is removed after the conference ends.';
export const STOP_ONE_COPY = 'If you stop, this phone stops trying; anything our server still holds is removed after the conference ends.';

/**
 * Shown while a profile delete has not been confirmed by the server, with a way to try again and,
 * once the server keeps refusing this device, a way to stop. What "Delete my profile" reports goes
 * to `onResult`, so the Delete card shows it.
 */
function PendingDelete({ conference, onResult }: { conference: ConferenceLike; onResult: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const all = getDeleteAll() !== null;
  const pending = slugsDeletePending();
  if (!all && !pending.length) return null;
  const detail = getPendingDeleteDetail();
  const where =
    pending.length > 1
      ? `${pending.length} conferences`
      : pending[0] === conference.slug
        ? conference.name
        : 'another conference';
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    const message = await fn();
    if (message) onResult(message);
    setBusy(false);
  };
  // After "Delete my profile", trying again runs the whole delete, so the device's data goes too.
  const retry = () => run(async () => (all ? (await deleteMyProfile()).message : (await finishPendingDeletes(), null)));
  return (
    <div class="pp-banner" role="status">
      <div class="pp-banner-row">
        <TriangleAlert size={20} aria-hidden="true" class="pp-banner-icon" />
        <p class="pp-banner-text">
          <strong>{all ? 'Deleting your profile has not finished.' : `Removing your profile from ${where} has not finished.`}</strong>{' '}
          {pending.length > 0 && `${PENDING_HIDDEN_COPY} `}
          {PENDING_DELETE_COPY}
        </p>
      </div>
      {detail && <p class="pp-error pp-banner-actions">{detail}</p>}
      {canStopTrying() && (
        <p class="pp-hint pp-banner-actions">
          {STOP_TRYING_COPY} {all ? STOP_ALL_COPY : STOP_ONE_COPY}
        </p>
      )}
      <div class="pp-banner-actions pp-actions">
        <button type="button" class="btn btn-tonal btn-small" disabled={busy} onClick={retry}>
          {busy ? 'Working…' : 'Try again'}
        </button>
        {canStopTrying() && (
          <button type="button" class="btn btn-text btn-small pp-danger" disabled={busy} onClick={() => run(stopTrying)}>
            Stop trying on this device
          </button>
        )}
      </div>
    </div>
  );
}

export function ProfileScreen({ conference, interested }: { conference: ConferenceLike; interested: InterestedProp }) {
  usePeopleStore();
  const slug = conference.slug;
  const profile = getProfile() ?? EMPTY_PROFILE;
  const topics = topicsFor(profile, slug);
  const vis = getVisibility(slug);
  const talkIds = interestedIds(interested);
  const [visBusy, setVisBusy] = useState(false);
  // The switch shows the requested state while the first save, which can take a second or two,
  // is running. If the save fails it falls back to the stored state and the message explains why.
  const [visPending, setVisPending] = useState<boolean | null>(null);
  const [visMessage, setVisMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);

  const update = (patch: Partial<Profile>) => {
    setProfile({ ...(getProfile() ?? EMPTY_PROFILE), ...patch });
    scheduleProfileSync();
  };

  const setTopics = (which: 'learn' | 'speak', next: TopicRef[]) => {
    const p = getProfile() ?? EMPTY_PROFILE;
    const cur = topicsFor(p, slug);
    update({ topics: { ...p.topics, [slug]: { ...cur, [which]: next } } });
  };

  const linkedinProblem =
    profile.linkedin_url.trim() && !LINKEDIN_RE.test(profile.linkedin_url.trim())
      ? 'Use a link like https://www.linkedin.com/in/your-name'
      : null;

  const toggleVisible = async (on: boolean) => {
    setVisBusy(true);
    setVisPending(on);
    setVisMessage(await changeVisibility(slug, { open_to_meet: on }));
    setVisPending(null);
    setVisBusy(false);
  };

  // The device's data goes only once the server has confirmed the delete for every conference. On
  // a failure the confirmation stays open, so the same button tries again.
  const removeEverything = async () => {
    setDeleting(true);
    setDeleteMessage(null);
    const result = await deleteMyProfile();
    if (result.done) setConfirmDelete(false);
    setDeleteMessage(result.message);
    setDeleting(false);
  };

  return (
    <div class="pp-screen pp-profile">
      <SaveStatus />
      <PendingDelete conference={conference} onResult={setDeleteMessage} />
      {vis.hidden_for_owner && (
        <div class="pp-banner pp-hidden-banner" role="status">
          <div class="pp-banner-row">
            <EyeOff size={20} aria-hidden="true" class="pp-banner-icon" />
            <p class="pp-banner-text">
              <strong>Hidden after reports.</strong> {HIDDEN_COPY}
            </p>
          </div>
        </div>
      )}

      <section class="pp-card" aria-labelledby="pp-about-h">
        <h2 id="pp-about-h" class="pp-card-title">
          About you
        </h2>
        <TextField
          id="pp-name"
          label="Name"
          value={profile.display_name}
          max={60}
          placeholder="How people will see you"
          onInput={(v) => update({ display_name: v })}
        />
        <TextField
          id="pp-about"
          label="About me"
          value={profile.about}
          max={280}
          multiline
          placeholder="One or two lines, for example your role and what you work on"
          onInput={(v) => update({ about: v })}
        />
        <ImportGitHub slug={slug} onAccept={(a) => { const m = mergeGithubImport(profile, topics.speak, a); update(m.patch); setTopics('speak', m.speak); }} />
      </section>

      <section class="pp-card">
        <TopicPicker
          slug={slug}
          title="I want to learn about"
          selected={topics.learn}
          onChange={(next) => setTopics('learn', next)}
          suggestText={profile.interests}
          talkIds={talkIds}
        />
        <TextField
          id="pp-interests"
          label="What I'm trying to learn or figure out next"
          value={profile.interests}
          max={500}
          multiline
          placeholder="For example: getting Postgres failover under a minute, or why our GPU inference costs so much"
          hint={SPECIFIC_HINT}
          onInput={(v) => update({ interests: v })}
        />
      </section>

      <section class="pp-card">
        <TopicPicker
          slug={slug}
          title="I can speak to"
          selected={topics.speak}
          onChange={(next) => setTopics('speak', next)}
          suggestText={profile.expertise}
          talkIds={[]}
        />
        <TextField
          id="pp-expertise"
          label="Things I've built, run or broken"
          value={profile.expertise}
          max={500}
          multiline
          placeholder="For example: ran Postgres operators on bare metal for 3 years"
          hint={SPECIFIC_HINT}
          onInput={(v) => update({ expertise: v })}
        />
      </section>

      <section class="pp-card" aria-labelledby="pp-reach-h">
        <h2 id="pp-reach-h" class="pp-card-title">
          How to reach me
        </h2>
        <p class="pp-hint">Optional. Shown only to people you choose to be visible to.</p>
        <TextField
          id="pp-linkedin"
          label="LinkedIn link"
          type="url"
          value={profile.linkedin_url}
          max={200}
          placeholder="https://www.linkedin.com/in/your-name"
          invalid={linkedinProblem}
          onInput={(v) => update({ linkedin_url: v })}
        />
        <TextField
          id="pp-contact"
          label="Another way to reach me"
          value={profile.contact_note}
          max={120}
          placeholder="For example: @sam on the CNCF Slack"
          onInput={(v) => update({ contact_note: v })}
        />
      </section>

      <section class="pp-card" aria-labelledby="pp-vis-h">
        <h2 id="pp-vis-h" class="pp-card-title">
          Visibility
        </h2>
        <label class="pp-switch-row">
          <span>Visible to other attendees at {conference.name}</span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            checked={visPending ?? vis.open_to_meet}
            disabled={visBusy}
            onChange={(e) => toggleVisible((e.target as HTMLInputElement).checked)}
          />
        </label>
        {visBusy && (
          <p class="pp-status" role="status">
            Saving…
          </p>
        )}
        <p class="pp-notice-text">{VISIBILITY_NOTICE}</p>
        {vis.shared_talk_ids.length > 0 && (
          <div class="pp-actions pp-shared-row">
            <p class="pp-hint">
              You also share your profile for {vis.shared_talk_ids.length}{' '}
              {vis.shared_talk_ids.length === 1 ? 'talk' : 'talks'}.
            </p>
            <button
              type="button"
              class="btn btn-text btn-small"
              disabled={visBusy}
              onClick={() => void unshareAll(slug).then((err) => err && setVisMessage(err))}
            >
              Stop sharing for all talks
            </button>
          </div>
        )}
        {visMessage && <p class="pp-error">{visMessage}</p>}
      </section>

      <section class="pp-card" aria-labelledby="pp-del-h">
        <h2 id="pp-del-h" class="pp-card-title">
          Delete
        </h2>
        {!confirmDelete ? (
          <button type="button" class="btn btn-text pp-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={18} aria-hidden="true" />
            Delete my profile
          </button>
        ) : (
          <div class="pp-notice">
            <p>
              This removes your profile from this phone and from our server, for every conference, along with your
              presence, your requests to talk shop and the people you blocked. It cannot be undone.
            </p>
            <div class="pp-actions">
              <button type="button" class="btn btn-danger btn-small" disabled={deleting} onClick={removeEverything}>
                {deleting ? 'Deleting…' : 'Delete my profile'}
              </button>
              <button type="button" class="btn btn-text btn-small" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {deleteMessage && <p class="pp-hint" role="status">{deleteMessage}</p>}
      </section>
    </div>
  );
}
