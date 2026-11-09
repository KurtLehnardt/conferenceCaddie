// Profile import. Only the interface exists: the LinkedIn adapter is a stub that
// fetches nothing and makes no network call.
import type { Profile } from './types';

export type ImportSource = 'linkedin';

export type ImportResult =
  | { ok: true; profile: Partial<Omit<Profile, 'topics'>> }
  | { ok: false; error: string };

const adapters: Record<ImportSource, () => Promise<ImportResult>> = {
  linkedin: async () => ({ ok: false, error: 'not implemented' }),
};

export function importProfile(source: ImportSource): Promise<ImportResult> {
  const adapter = adapters[source];
  return adapter ? adapter() : Promise.resolve({ ok: false, error: 'not implemented' });
}
