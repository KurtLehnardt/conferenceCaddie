// The welcome guide's entry points. The dialogs themselves (SweetAlert2 and its stylesheet) are in
// run.ts, which is loaded only when the guide starts, so none of it is in the first-load bundle.
import { getProfile, topicsFor } from '../people/storage';
import { loadInterested } from '../lib/storage';
import type { Tab, TabParams } from '../lib/route';
import { claimAutoGuide, claimReplay, isOnboarded, markGuide } from './state';

/** The view and day last shown on each tab, so the guide leaves them as they were. */
export type TabViews = () => Partial<Record<Tab, TabParams>>;

let running = false;

async function start(slug: string, views: TabViews, auto: boolean): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { runGuide } = await import('./run');
    await runGuide({
      needsTopics: () => {
        const topics = topicsFor(getProfile(), slug);
        return topics.learn.length === 0 && topics.speak.length === 0;
      },
      tabParams: (tab) => views()[tab] ?? {},
      // Written when the first dialog is on screen, not when the guide ends, so leaving it without
      // a button (a reload, closing the tab, the browser's Back) does not bring it back by itself.
      // A replay does not write it: whatever was saved stays.
      onShown: auto ? () => markGuide('shown') : undefined,
      onEnd: markGuide,
    });
  } catch {
    // The chunk could not be loaded, for example offline before the first visit finished caching
    // it. The guide is left for the next visit or for the help button.
  } finally {
    running = false;
  }
}

/**
 * Opens the guide by itself on a first visit to an event page: only once, never to someone who
 * already has a profile, topics or marked talks on this device, and never while `blocked` says
 * another dialog is open.
 */
export function maybeStartGuide(slug: string, blocked: boolean, views: TabViews): void {
  if (running || blocked) return;
  if (!claimAutoGuide(isOnboarded(getProfile(), loadInterested(slug).length))) return;
  void start(slug, views, true);
}

/** The help button in Settings: starts the guide from step 1 whatever was saved. */
export function replayGuide(slug: string, views: TabViews): void {
  if (running) return;
  claimReplay();
  void start(slug, views, false);
}
