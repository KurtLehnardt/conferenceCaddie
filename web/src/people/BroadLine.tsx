// The first line of a broad match's card: the server's "Also interested in {topics}." reason,
// as sent. A broad match was found only through a common topic, so it has no evidence and sits
// after every specific match in the "Around now" list (the server orders them; nothing re-sorts).
import { Users } from 'lucide-preact';
import type { PersonResult } from './types';
import { Marked } from './util';

export function broadReason(person: PersonResult): string {
  return (person.reasons ?? []).find((r) => r.startsWith('Also interested in')) ?? person.opener ?? '';
}

export function BroadLine({ person }: { person: PersonResult }) {
  const line = broadReason(person);
  if (!line) return null;
  return (
    <p class="pp-broad">
      <Users size={16} aria-hidden="true" />
      <span>
        <Marked text={line} />
      </span>
    </p>
  );
}
