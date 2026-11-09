# Import from GitHub: integration notes for the coordinator

The GitHub import was built as new files only, so it does not conflict with the people and profile work in flight. Two existing files still need one small change each, and they are owned by other workers, so the exact lines are here instead of in a diff.

## Already done on `then/github-import`

| File | What |
|---|---|
| `server/import-github.mjs` (new) | `POST /api/import/github`; exports `handleImportGithubApi`, plus `buildProposal`, `mapTopics`, `fetchGithub`, `proposeFromGithub` for tests. |
| `server/index.mjs` | One import line and one mount line in `handleApi`, after `handleTopicsApi`. |
| `web/src/people/importGithub.ts` (new) | `importGithub(event, handle, signal?)`, `normalizeHandle`, `GITHUB_HANDLE_RE`, the `GithubProposal` type and the error copy. |
| `web/src/people/ImportGitHub.tsx` (new) | The inline component and the pure `mergeGithubImport` helper. Imports `./import.css`. |
| `web/src/people/import.css` (new) | Styles, shell custom properties only. |
| `web/src/people/import.ts` | `importProfile('github')` returns `{ ok: true }`; `'linkedin'` unchanged. |
| `web/src/mock/github.ts` (new) | `mockImportGithub(handle, fail)` for `VITE_MOCK=1`; marked `MOCK_FIXTURE_DO_NOT_SHIP`. |
| `docs/CONTRACT.md` | Route section appended; `GITHUB_TOKEN` line appended to Keys. |

## 1. `web/src/people/ProfileScreen.tsx` (three lines)

Add the import next to the other people imports:

```tsx
import { ImportGitHub, mergeGithubImport } from './ImportGitHub';
```

In the "About you" card, replace the disabled LinkedIn button

```tsx
        <button type="button" class="btn btn-tonal btn-small pp-import" disabled>
          Import from LinkedIn (coming soon)
        </button>
```

with the component, whose `onAccept` merges through the existing `update` and `setTopics` helpers (`profile` and `topics` are the variables already in scope in `ProfileScreen`):

```tsx
        <ImportGitHub slug={slug} onAccept={(a) => { const m = mergeGithubImport(profile, topics.speak, a); update(m.patch); setTopics('speak', m.speak); }} />
```

`mergeGithubImport` appends the built-things text to any existing `expertise` after a blank line (cut to 500), fills `about` only when it is empty (cut to 280) and adds the chosen chips to "I can speak to" after the current ones (cap 30, no duplicates). Nothing is overwritten.

If the brief's "Import from LinkedIn (coming soon)" button should stay visible for now, keep it after the component; the two are independent. `docs/CONTRACT.md` Frontend brief still describes the disabled LinkedIn button; update that sentence when the button goes.

## 2. `web/src/mock/handler.ts` (two lines)

Import, next to the fixtures import:

```ts
import { mockImportGithub } from './github';
```

Route, anywhere inside `route()` before the final fall-through (it uses the file's own `HttpError`):

```ts
  if (path === '/api/import/github' && method === 'POST') return mockImportGithub(String(body.handle ?? ''), (s, b) => new HttpError(s, b));
```

Mock handles: `octocat` gives a proposal whose chips (`Kubernetes`, `eBPF`, `Service Mesh`) exist in the mock topics; `busy` gives 429 `rate_limited`; `down` gives 502 `upstream`; anything else gives 404 `not_found`.

Both sets of lines were typechecked against the current tree with throwaway files (`npx tsc --noEmit -p web` clean) and the files were removed again.

## Deploy

- `GITHUB_TOKEN` is optional. Without it the server calls GitHub unauthenticated (60 requests an hour per egress address, two per import). To raise that, create a fine-grained token with no repository access (public data only), store it as Secret Manager `caddie-github-token` and mount it as env `GITHUB_TOKEN` on the Cloud Run service, like the Elasticsearch keys. Never print or write it.
- No Elasticsearch change: the route reads topics with the read-only key through the existing topics module and writes nothing.
- The CSP needs no change: the browser talks only to our origin; the server talks to `api.github.com`.

## What was verified and what was not

- `node --check` on both server files; `npx tsc --noEmit -p web` clean.
- The server starts with placeholder env; `POST /api/import/github` returns 400 `{ error: "handle is not a GitHub user name" }` for a malformed handle, 400 for an unknown key or bad slug, 405 for GET, 415 without JSON, and our own 429 `{ error: "Too many requests" }` on the sixth call in ten minutes. The request log holds no handle.
- `buildProposal` was checked with a saved fixture: forks and archived repositories excluded, the recent-repository weighting, the 280/500/20 caps, an over-long description cut to the field, and all five GitHub failure classes mapped (404, 403 with `x-ratelimit-remaining: 0`, 429, 500, network error).
- Live GitHub: the build environment's egress address was already at GitHub's unauthenticated limit, so the live call returned 403 with zero remaining and the server mapped it to 429 `{ error: "rate_limited" }` with `Retry-After: 600`. The environment's own `GITHUB_TOKEN` was rejected by GitHub (401), mapped to 502 `upstream`. A real proposal for a public handle (for example `torvalds`) was therefore **not** fetched end to end here; run `GITHUB_TOKEN= ES_API_KEY="$ELASTISEARCH_API_KEY" ... node server/index.mjs` from a machine with headroom and post `{ "event": "<slug>", "handle": "torvalds" }` to confirm `suggested_speak_topics` against a real topic index.
- The component was not rendered in a browser (it is not wired into `ProfileScreen.tsx` yet); its states (idle, form, loading, preview, errors) typecheck and follow the `pp-*` classes of the profile screen.
