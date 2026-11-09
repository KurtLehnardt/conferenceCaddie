# Report: what the people and meet code must add

`server/report.mjs` writes the flags; it reads nothing back. These are the exact clauses that make a hidden target disappear for everyone but its owner. Names refer to `server/people.mjs` and `server/connect.mjs` as of the `then/report-moderation` snapshot. Run `node scripts/es-setup-reports.mjs` after `es-setup-people.mjs` first, or the `hidden` filters match nothing.

## server/people.mjs

1. **`OWN_FIELDS`**: add `'hidden', 'spot_hidden'`, so `ownDoc` and `authenticated` return them.
2. **`OTHER_FIELDS`**: add `'hidden'`, so `peopleByIds`, `docByRef` and `personByRef` can see it.
3. **`peopleQuery` filter** (matches, "Around now" and circle members all go through it): in `must_not`, add `{ term: { hidden: true } }`:
   ```js
   must_not: [{ ids: { values: [docId(me.event_id, me.profile_id)] } }, { term: { hidden: true } }, ...notBlocked(me.event_id, blocked)],
   ```
4. **`circleCounts`**: add `must_not: [{ term: { hidden: true } }]` to its `bool`, so a count never exceeds the members a sharer can see.
5. **`personByRef`** (meet request target): after the `profile_id` check, add `if (s.hidden === true) return null;`. Leave `docByRef` unfiltered: a hidden person must stay blockable and reportable.
6. **`putProfile`**:
   - The full reindex path (the `index` action) rebuilds the document and would silently unhide it. Carry the flags over next to `...presence`:
     ```js
     const flags = own.found ? { hidden: own.source.hidden === true, spot_hidden: own.source.spot_hidden === true } : {};
     ```
     and spread `...flags` into the `index` document (the `create` and `update` paths need nothing).
   - Response: `sendJson(res, 200, { ok: true, open_to_meet: body.open_to_meet, shared_talk_ids: shared, hidden_for_owner: own.found && own.source.hidden === true })`. The web client shows "Hidden after reports" when it is `true`. The early return for a deleted profile stays as it is.

## server/connect.mjs

7. **`putPresence`**: a hidden spot stays off until the operator unhides it. Once `me` is loaded: `const storedSpot = me.spot_hidden === true ? null : spot;`, write `presence_spot: storedSpot`, and return `spot: storedSpot, spot_hidden: me.spot_hidden === true`.
8. **`requestMeet`**: a hidden profile must not surface in anyone's inbox. After `requireProfile`: `if (me.hidden === true) throw new HttpError(403, { error: 'hidden' });`.
9. **Hidden meets.** A hidden meet document carries `hidden: true` and `hidden_owner_id` (the reported participant's `profile_id`). Everyone else gets nothing:
   - `inbox`: in the loop, `if (s.hidden === true && s.hidden_owner_id !== me.profile_id) continue;` (next to the `!other || hidden.has(otherId)` line; rename that local `hidden` Set if the shadowing bothers you).
   - `participantMeet` (serves `GET /api/meet/{id}`, every action and `PUT details`): after the participant check, `if (s.hidden === true && s.hidden_owner_id !== me.profile_id) throw notFound();`.
   - `saveMeet` and `closeMeets` write the whole `_source` back, so the two fields survive them without change. `hidden_owner_id` is never put in `meetView`.
10. **`inbox`**: the other participant may be a hidden profile. Treat `other?.hidden === true` like a missing document: `if (!other || other.hidden === true || hidden.has(otherId)) continue;`.

## Elsewhere

- `server/index.mjs` already mounts `handleReportApi` (done on this branch). Add `ES_PEOPLE_REPORTS_INDEX` to its env comment when you next touch it.
- Root `package.json` (integrator-owned): `"reports:setup": "node scripts/es-setup-reports.mjs"` and `"moderation": "node scripts/moderation.mjs"` would fit the existing names.
- `scripts/smoke.mjs`: two devices report a third profile; the third person vanishes from matches and circle members for both and a meet request to them gets 404, while the owner's `PUT /api/people/profile` answers `hidden_for_owner: true`; a second report by the same device answers 200 without hiding.
- Web: a "Report" entry in the person card's overflow menu next to "Block", on the meet screen and on a spot line; the "Hidden after reports" banner on the profile screen when `hidden_for_owner` is true.
