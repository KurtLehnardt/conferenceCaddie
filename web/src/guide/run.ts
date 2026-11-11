// The welcome guide's dialogs. This module is imported on demand (see index.ts), so SweetAlert2 and
// its stylesheet stay out of the first-load bundle. The guide is a sequence of SweetAlert2 dialogs,
// one per step: before each one the app is switched to the screen the step describes, and the
// dialog sits at the bottom (or, for Settings, the top) with a light backdrop so that screen
// stays visible behind it.
import Swal from 'sweetalert2/dist/sweetalert2.esm.js';
import 'sweetalert2/dist/sweetalert2.min.css';
import './guide.css';
import { replaceHash, replaceTabParams } from '../lib/route';
import { GUIDE_STEPS, type GuideStep } from './steps';
import type { GuideOutcome } from './state';

export interface GuideRun {
  /** True when the person has no topics yet, so the last step leads into picking them. */
  needsTopics: () => boolean;
  /** Called once when the guide ends, before the app is put back where it was. */
  onEnd: (outcome: GuideOutcome) => void;
}

/** Waits for the app to paint the screen it was just switched to. */
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(n);
  });

async function showScreen(step: GuideStep): Promise<void> {
  replaceTabParams(step.tab, {});
  // The app scrolls to the top when the tab changes, a moment after the route event.
  await frames(3);
  // The Settings step keeps the bottom of the page in view, where the help icon is.
  if (step.id === 'settings') window.scrollTo(0, document.documentElement.scrollHeight);
  if (step.reveal) {
    // The part of the screen the step talks about may load a moment after the screen itself.
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector<HTMLElement>(step.reveal);
      if (el) {
        // Leave room for the app bar above it.
        el.style.scrollMarginTop = 'calc(var(--appbar-h) + var(--safe-top) + 8px)';
        el.scrollIntoView({ block: 'start' });
        return;
      }
      await frames(2);
    }
  }
}

function dialogOptions(step: GuideStep, index: number, needsTopics: boolean) {
  const total = GUIDE_STEPS.length;
  const last = index === total - 1;
  return {
    // The step count is spoken to screen readers as part of the title, which names the dialog.
    title: `<span class="sr-only">Step ${index + 1} of ${total}: </span>${step.title}`,
    text: step.body,
    position: step.position,
    progressSteps: GUIDE_STEPS.map((_, i) => String(i + 1)),
    currentProgressStep: index,
    showConfirmButton: true,
    confirmButtonText: last ? (needsTopics ? 'Pick my topics' : 'Done') : 'Next',
    showDenyButton: index > 0,
    denyButtonText: 'Back',
    showCancelButton: true,
    cancelButtonText: 'Skip',
    // Skip, Back, Next in the page order and the Tab order.
    reverseButtons: true,
    focusConfirm: true,
    // Escape skips the guide. A tap beside the dialog does nothing, because the screen behind it
    // is the point of the tour and a stray tap should not end it.
    allowEscapeKey: true,
    allowOutsideClick: false,
    // The guide puts focus back itself at the end, since the screen it started from may have been
    // swapped out and rebuilt in between.
    returnFocus: false,
    // No motion at all: no show or hide animation, and the stylesheet drops the transitions.
    animation: false,
    heightAuto: false,
    scrollbarPadding: false,
    buttonsStyling: false,
    customClass: {
      container: `caddie-guide caddie-guide-${step.position}`,
      popup: 'caddie-guide-popup',
      title: 'caddie-guide-title',
      htmlContainer: 'caddie-guide-text',
      actions: 'caddie-guide-actions',
      confirmButton: 'btn btn-primary',
      denyButton: 'btn btn-tonal',
      cancelButton: 'btn btn-text',
    },
  } as const;
}

/**
 * Runs the guide from step 1 and resolves when it ends. Next and Back move between steps; Skip,
 * Escape and Done end it. The app is put back on the screen it started from at the end.
 */
export async function runGuide(run: GuideRun): Promise<void> {
  const startHash = location.hash;
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const startedInSettings = /^#\/settings/.test(startHash);
  let index = 0;
  let outcome: GuideOutcome = 'skipped';
  let toTopics = false;

  try {
    for (;;) {
      const step = GUIDE_STEPS[index];
      await showScreen(step);
      const last = index === GUIDE_STEPS.length - 1;
      const needsTopics = last && run.needsTopics();
      const result = await Swal.fire(dialogOptions(step, index, needsTopics));
      if (result.isConfirmed) {
        if (!last) {
          index += 1;
          continue;
        }
        outcome = 'done';
        toTopics = needsTopics;
        break;
      }
      if (result.isDenied) {
        index = Math.max(0, index - 1);
        continue;
      }
      // Skip, Escape, or a close from elsewhere.
      outcome = 'skipped';
      break;
    }
  } finally {
    Swal.close();
    run.onEnd(outcome);
    replaceHash(startHash);
    if (toTopics) location.hash = '#/profile';
    await frames(3);
    // Focus goes back where it was; if that element was rebuilt, to the Settings help button when
    // the guide started there, and otherwise to the start of the page content.
    const target =
      !toTopics && origin?.isConnected
        ? origin
        : !toTopics && startedInSettings
          ? document.querySelector<HTMLElement>('[data-guide-help]')
          : document.getElementById('main');
    if (target) {
      if (target.id === 'main' && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  }
}
