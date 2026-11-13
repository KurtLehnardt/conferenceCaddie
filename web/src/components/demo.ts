// The "Demo" label of a demo conference: a conference whose talks, speakers and times are invented
// so the app can be shown without a real event. Its entry in GET /api/conferences (and in the
// bundles' conferences.json and bundle.json) carries "demo": true; any other value, or no field,
// is a real conference.
//
// Wherever a demo conference's data shows, the app shows the same pill, so a demo can never be
// mistaken for a real event: after its name in the app bar and the conference switcher, after the
// titles of Profile, Requests and Meet up, at the top of every full talk card (search results,
// Interested, offline search and the talk sheet), and with a note at the top of every screen of
// the conference, of Settings' people groups and of the Import my schedule sheet. Every
// notification about a demo conference, from a server or shown by the app itself, follows one rule
// (docs/contracts/talk-bundle.md): its title is "Conference Caddie (Demo)" and its body starts with
// "Demo: ". The pill looks like the people screens' "Sample" pill (.pp-sample), and the native apps
// draw the same pill with the same words.
//
// This file has no JSX on purpose: the tests run under node --test, which cannot load .tsx files,
// so the elements are built with h() here and the tests check the elements themselves.
import { h } from 'preact';

/** The pill's visible text. The style shows it in capitals, as "DEMO". */
export const DEMO_LABEL = 'Demo';

/** What screen readers hear for the pill, and its tooltip. */
export const DEMO_SPOKEN = 'Demo conference, invented data';

/** The line next to the pill at the top of every screen of a demo conference. */
export const DEMO_NOTE = 'A demo conference with invented talks and speakers, not a real event.';

/** What a heading of demo data adds for screen readers, after the visible title, since the pill sits above it. */
export const DEMO_HEADING_SUFFIX = ', Demo conference';

/** What the body of a notification about a demo conference starts with. */
export const DEMO_BODY_PREFIX = 'Demo: ';

/** True only when the conference entry says "demo": true; a missing field or any other value is a real conference. */
export function isDemo(conference: { demo?: unknown } | null | undefined): boolean {
  return conference?.demo === true;
}

/** The conference name for text outside the pill, such as the browser tab's title: "Name (Demo)" for a demo conference. */
export function demoName(name: string, demo: boolean): string {
  return demo ? `${name} (Demo)` : name;
}

/**
 * The title of a notification about a conference: "Conference Caddie (Demo)" for a demo
 * conference, by the same rule as demoName, and [title] unchanged otherwise (Demo.notificationTitle
 * on the native apps).
 */
export function demoTitle(title: string, demo: boolean): string {
  return demoName(title, demo);
}

/** The body of a notification about a conference: "Demo: " and [body] for a demo conference, [body] otherwise. */
export function demoBody(body: string, demo: boolean): string {
  return demo ? DEMO_BODY_PREFIX + body : body;
}

/** The screen-reader words a heading of demo data ends with, inside the heading: nothing for a real conference. */
export function demoHeadingSuffix(conference: { demo?: unknown } | null | undefined) {
  return isDemo(conference) ? h('span', { class: 'sr-only' }, DEMO_HEADING_SUFFIX) : null;
}

/** The pill itself, the same markup as the people screens' "Sample" pill. */
export function demoPill() {
  return h(
    'span',
    { class: 'demo-pill', title: DEMO_SPOKEN },
    h('span', { 'aria-hidden': 'true' }, DEMO_LABEL),
    h('span', { class: 'sr-only' }, DEMO_SPOKEN),
  );
}

/** The pill for a conference: the pill when it is a demo conference, nothing otherwise. */
export function demoPillFor(conference: { demo?: unknown } | null | undefined) {
  return isDemo(conference) ? demoPill() : null;
}

/** The pill and the note in one row for a conference, or nothing when it is not a demo conference. */
export function demoNoteFor(conference: { demo?: unknown } | null | undefined) {
  if (!isDemo(conference)) return null;
  return h('p', { class: 'demo-note' }, demoPill(), h('span', { class: 'demo-note-text' }, DEMO_NOTE));
}

/** The pill when [demo] is true. */
export function DemoPill({ demo = true }: { demo?: boolean }) {
  return demo ? demoPill() : null;
}

/** The pill and the note at the top of a screen of a demo conference; nothing for a real conference. */
export function DemoNote({ conference }: { conference: { demo?: unknown } | null | undefined }) {
  return demoNoteFor(conference);
}
