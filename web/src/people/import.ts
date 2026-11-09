// Profile import. GitHub is the first real source: the ImportGitHub component runs the whole
// flow (handle, server proposal, preview, accept) inline in the profile screen, so the adapter
// here only reports that the source is available. LinkedIn is still a stub that fetches nothing
// and makes no network call.
import type { Profile } from './types';

export type ImportSource = 'linkedin' | 'github';

export type ImportResult =
  | { ok: true; profile?: Partial<Omit<Profile, 'topics'>> }
  | { ok: false; error: string };

const adapters: Record<ImportSource, () => Promise<ImportResult>> = {
  linkedin: async () => ({ ok: false, error: 'not implemented' }),
  // The UI handles GitHub itself; nothing is fetched here.
  github: async () => ({ ok: true }),
};

export function importProfile(source: ImportSource): Promise<ImportResult> {
  const adapter = adapters[source];
  return adapter ? adapter() : Promise.resolve({ ok: false, error: 'not implemented' });
}
