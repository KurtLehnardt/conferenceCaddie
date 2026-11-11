// When the welcome guide shows by itself. This file holds only the decision and the memory of it,
// so it can be tested without a browser. The dialogs are in run.ts and are loaded on demand.

/** The versioned key that remembers the guide was finished or skipped. A new guide gets a new key. */
export const GUIDE_KEY = 'caddie.guide.v1';

export type GuideOutcome = 'done' | 'skipped';

// Set the first time the guide is claimed in this page load, whether or not the key could be
// written. It is what keeps the guide from showing again when storage is blocked.
let claimed = false;

/** The saved outcome, null when the key is not there, and undefined when storage cannot be read. */
export function readGuideOutcome(): GuideOutcome | null | undefined {
  try {
    const raw = localStorage.getItem(GUIDE_KEY);
    if (!raw) return null;
    try {
      const outcome = (JSON.parse(raw) as { outcome?: unknown } | null)?.outcome;
      return outcome === 'skipped' ? 'skipped' : 'done';
    } catch {
      // Any value under the key means the guide has been seen.
      return 'done';
    }
  } catch {
    return undefined;
  }
}

/** Remembers how the guide ended. A blocked or full storage is ignored; the page-load flag still holds. */
export function markGuide(outcome: GuideOutcome): void {
  claimed = true;
  try {
    localStorage.setItem(GUIDE_KEY, JSON.stringify({ outcome, at: new Date().toISOString() }));
  } catch {
    // The guide is not shown again in this page load, and may be shown once on the next visit.
  }
}

/**
 * Decides whether the guide should open by itself now, and if so claims it, so a second call in the
 * same page load says no. `onboarded` is true when this device already holds a profile or topics.
 * With no readable storage the guide still shows, but at most once per page load.
 */
export function claimAutoGuide(onboarded: boolean): boolean {
  if (claimed || onboarded) return false;
  if (readGuideOutcome() != null) return false;
  claimed = true;
  return true;
}

/** Marks the guide as claimed without a decision, for a replay that the person asked for. */
export function claimReplay(): void {
  claimed = true;
}

/** For tests: forgets the page-load flag. */
export function resetGuideClaim(): void {
  claimed = false;
}

interface ProfileLike {
  display_name: string;
  interests: string;
  expertise: string;
  topics: Record<string, { learn: unknown[]; speak: unknown[] }>;
}

/**
 * True when the device already holds a profile with a name, topics or text, or talks marked for
 * this conference: someone who has used the app before and does not need the welcome.
 */
export function isOnboarded(profile: ProfileLike | null, markedTalks: number): boolean {
  if (markedTalks > 0) return true;
  if (!profile) return false;
  if (profile.display_name.trim() || profile.interests.trim() || profile.expertise.trim()) return true;
  return Object.values(profile.topics).some((t) => t.learn.length > 0 || t.speak.length > 0);
}
