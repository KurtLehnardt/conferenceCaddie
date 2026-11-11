// Decides whether a command runs for real or only previews. Destructive commands preview unless
// --yes is given; with --yes the operator must also name the exact target, by --confirm or, on a
// terminal, by typing it.

import { ConfirmError } from './errors.mjs';

export async function resolveMode({ destructive, target, yes, confirm, dryRun, isTTY, prompt }) {
  if (!destructive) return 'run';
  if (dryRun || !yes) return 'dry-run';
  if (confirm !== undefined) {
    if (confirm !== target) throw new ConfirmError(`--confirm does not match the target (${target}); nothing was changed`);
    return 'run';
  }
  if (!isTTY) throw new ConfirmError(`--yes without a terminal needs --confirm ${target}; nothing was changed`);
  const typed = await prompt(`Type the target (${target}) to confirm, or anything else to abort: `);
  if (String(typed).trim() !== target) throw new ConfirmError('confirmation not given; nothing was changed');
  return 'run';
}
