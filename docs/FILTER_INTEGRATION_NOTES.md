# Filter integration notes: wiring `hold` into connect.mjs

For the coordinator. `server/moderation.mjs` now exports the full filter as `moderate(line)`; the
MVP exports `isFiltered(line)` (boolean, in process) and `FILTERED` are unchanged, so `connect.mjs`
keeps working as it is. Until the lines below are applied, though, **neither the percolator nor the
classifier runs**: `connect.mjs` still calls the synchronous `isFiltered`. Line numbers refer to
`server/connect.mjs` at the merged MVP (commit `0aa0ac6`).

## The contract

```js
import { moderate } from './moderation.mjs';
const r = await moderate(text);
// r = { outcome: 'accept' | 'reject' | 'hold', body, category }
//   reject → throw new HttpError(400, r.body)        (r.body is FILTERED, as before)
//   hold   → store the line with a *_pending: true flag, show it only to its author, and tell the
//            author with r.body ({ error: 'held', message: 'Waiting for the filter; it will appear shortly.' })
//   accept → store and show it
// moderate() never throws and never logs the text; it logs "filter: accepted|rejected|held <category>".
```

Fail closed is already inside `moderate()`: a classifier error or timeout comes back as `hold`.

## Exact changes in `server/connect.mjs`

1. **Line 32** — replace the import:
   ```js
   import { moderate, HELD } from './moderation.mjs';
   ```
   (`FILTERED` is no longer needed here: the body comes from the verdict.)

2. **Lines 72–78** — make `line()` async and let it return the pending flag:
   ```js
   // A short line other people will read: trimmed, capped, and passed through the filter.
   // Returns { text, pending }: text is null for an empty line; pending is true when the classifier
   // held it (the line is then stored but shown only to its author until it is cleared).
   async function line(value, name, max) {
     const t = text(value, name, max);
     if (!t) return { text: null, pending: false };
     const verdict = await moderate(t);
     if (verdict.outcome === 'reject') throw new HttpError(400, verdict.body);
     return { text: t, pending: verdict.outcome === 'hold' };
   }
   // The extra key on a 200 response when a field was held. Old clients ignore it.
   const heldInfo = (fields) => (fields.length ? { held: { fields, message: HELD.message } } : {});
   ```

3. **Presence spot (`putPresence`, lines 287, 297, 300)**:
   ```js
   const { text: spot, pending: spotPending } = await line(body.spot, 'spot', SPOT_MAX);          // 287
   ...
   const presence = { presence_zone: zone, presence_spot: spot, presence_spot_pending: spotPending, presence_since: since, presence_until: iso(untilMs) }; // 297
   ...
   sendJson(res, 200, { ok: true, zone, spot, presence_since: since, presence_until: presence.presence_until, ...heldInfo(spotPending ? ['spot'] : []) }); // 300
   ```
   And where the other person's spot is shown, **line 190** in `meetView`:
   ```js
   spot: active && bothAround(me, other) && other.presence_spot_pending !== true ? other.presence_spot ?? null : null,
   ```
   The author always sees their own spot (the presence response); nobody else does while it is pending.
   Outside `connect.mjs` (people.mjs owner): add `presence_spot_pending` to `PRESENCE_FIELDS` (people.mjs line 501, otherwise `_source_includes` drops it and the flag is never read back) and `presence_spot_pending: null` to `PRESENCE_OFF` (line 149); es-setup-people.mjs owner: `presence_spot_pending: { type: 'boolean' }` in `connectProperties`. With `dynamic: false` the flag is stored and read back even before the mapping change, so the order does not matter.

4. **Meet note (`requestMeet`, lines 328 and 369; `meetView` line 177)**:
   ```js
   const { text: noteText, pending: notePending } = await line(body.note, 'note', NOTE_MAX);        // 328
   const note = noteText ?? '';
   ...
     note,
     note_pending: notePending,                                                                     // after 369
   ...
   sendJson(res, 200, { ok: true, ...meetView(s, me, them, labels), ...heldInfo(notePending ? ['note'] : []) }); // 380
   ```
   `meetView` line 177 — the note reaches only its author while pending:
   ```js
   note: s.note_pending === true && s.requester_id !== me.profile_id ? '' : s.note ?? null,
   ```
   The inbox (line ~414) builds its rows through `meetView`, so the recipient's inbox row gets `''` too, and `requested_by_me` still tells the client whose note it is. es-setup-people.mjs owner: `note_pending: { type: 'boolean' }` in `meetsProperties`.

5. **Spot-me (`putDetails`, lines 485–490; `meetView` line 191; `endMeet` line 125)**:
   ```js
   if (body.spot_me !== undefined) {
     const { text: spotMe, pending } = await line(body.spot_me, 'spot_me', SPOT_MAX);
     s.spot_me = { ...(s.spot_me ?? {}) };
     s.spot_me_pending = { ...(s.spot_me_pending ?? {}) };
     if (spotMe) s.spot_me[me.profile_id] = spotMe;
     else delete s.spot_me[me.profile_id];
     if (spotMe && pending) s.spot_me_pending[me.profile_id] = true;
     else delete s.spot_me_pending[me.profile_id];
     heldFields = pending ? ['spot_me'] : [];                      // declare `let heldFields = [];` above the if
   }
   ...
   sendJson(res, 200, { ok: true, ...meetView(s, me, other, labels), ...heldInfo(heldFields) }); // 502
   ```
   `meetView` line 191:
   ```js
   spot_me: active && otherId && s.spot_me_pending?.[otherId] !== true ? s.spot_me?.[otherId] ?? null : null,
   ```
   `endMeet` line 125: add `s.spot_me_pending = {};`. es-setup-people.mjs owner: `spot_me_pending: { type: 'object', enabled: false }` in `meetsProperties`.

6. **Report row (only if `server/reports.mjs` from the Report item exists).** After each hold, write one report with `reason: 'classifier'` on the author, so the hide-after-two-reports rule and the operator CLI see it:
   ```js
   // presence: context { kind: 'spot', id: me.profile_id }; meet note: { kind: 'meet', id: s.meet_id }; spot_me: { kind: 'meet', id: s.meet_id }
   await autoReport(conf.slug, me.profile_id, { kind, id }, 'classifier');   // whatever the reports module names its writer
   ```
   Use a fixed `reporter_id` such as `'classifier'` so the one-per-reporter-per-target rule dedupes repeated holds from the same author, and let it count as one of the two devices (one human report plus a classifier hold hides the person). If the reports module does not exist yet, skip this step; nothing else depends on it.

7. **Clearing a hold.** Nothing in the server re-checks a held line, so "it will appear shortly" is kept true only by two paths: the author edits and resubmits (a new `moderate()` call replaces the line and the flag), and the operator CLI of the Report item should gain `--release <id>` that sets the `*_pending` flag to false (or `--delete`). Presence expires within 60 minutes and a meet's note and spot-me are cleared when the meet ends, so a held line never outlives the MVP's own limits.

## Client (web owner)

- A 200 with `held: { fields: ['spot' | 'note' | 'spot_me'], message }` means the write succeeded; show `message` under that field, in the same calm style as the filtered error, and keep showing the author's text. Never say "safe".
- `web/src/people/api.ts` maps `error: 'filtered'` to `FILTERED_MESSAGE`; `held` is never an HTTP error, so nothing changes there. The mock handler (`web/src/mock/handler.ts`) can return `held` for a fixed marker string if a demo wants it.

## What stays true without any of this

`isFiltered` and `FILTERED` are untouched, so a `connect.mjs` that is not updated still rejects the wordlist and URLs exactly as the MVP did. The rules index and the classifier only start deciding once `line()` awaits `moderate()`.
