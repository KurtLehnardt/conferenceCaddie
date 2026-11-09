// Placeholder written by the shell task; the people task replaces it at merge.
// Profile import is a stub: no adapter fetches anything.

export type ImportSource = 'linkedin';

export async function importProfile(source: ImportSource): Promise<{ ok: false; error: string }> {
  void source;
  return { ok: false, error: 'not implemented' };
}
