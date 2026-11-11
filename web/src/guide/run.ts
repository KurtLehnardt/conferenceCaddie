// The welcome guide's dialogs. This module is imported on demand (see index.ts), so SweetAlert2 and
// its stylesheet stay out of the first-load bundle. The guide is one SweetAlert2 dialog that is
// updated from step to step: before each step the app is switched to the screen it describes, and
// the dialog sits at the bottom (or, for Settings, the top) with a light backdrop so that screen
// stays visible behind it. One dialog stays open all the way through, so there is never a moment
// with no backdrop in which a tap could reach the screen behind it.
import Swal from 'sweetalert2/dist/sweetalert2.esm.js';
import 'sweetalert2/dist/sweetalert2.min.css';
import './guide.css';
import { replaceHash, replaceTabParams, type Tab, type TabParams } from '../lib/route';
import { GUIDE_STEPS, type GuideStep } from './steps';
import type { GuideOutcome } from './state';

export interface GuideRun {
  /** True when the person has no topics yet, so the last step leads into picking them. */
  needsTopics: () => boolean;
  /** The view and day the app last showed on a tab, so visiting the tab leaves them as they were. */
  tabParams: (tab: Tab) => TabParams;
  /** Called once, when the first dialog is on screen. */
  onShown?: () => void;
  /** Called once when the guide ends, before the app is put back where it was. */
  onEnd: (outcome: GuideOutcome) => void;
}

/** Waits for the app to paint the screen it was just switched to. */
const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const tick = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(n);
  });

/** Waits for part of a screen that may load a moment after the screen itself. */
async function findElement(selector: string, gone: () => boolean): Promise<HTMLElement | null> {
  for (let i = 0; i < 30 && !gone(); i++) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await frames(2);
  }
  return null;
}

async function showScreen(step: GuideStep, params: TabParams, gone: () => boolean): Promise<void> {
  if (gone()) return;
  replaceTabParams(step.tab, params);
  // The app scrolls to the top when the tab changes, a moment after the route event.
  await frames(3);
  if (gone()) return;
  // The Settings step keeps the bottom of the page in view, where the help icon is.
  if (step.id === 'settings') window.scrollTo(0, document.documentElement.scrollHeight);
  if (step.reveal) (await findElement(step.reveal, gone))?.scrollIntoView({ block: 'start' });
}

/** The part of the options that changes from step to step; also what Swal.update accepts. */
function stepOptions(index: number, needsTopics: boolean) {
  const step = GUIDE_STEPS[index];
  const total = GUIDE_STEPS.length;
  const last = index === total - 1;
  return {
    // The step count is spoken to screen readers as part of the title, which names the dialog.
    title: `<span class="sr-only">Step ${index + 1} of ${total}: </span>${step.title}`,
    text: step.body,
    progressSteps: GUIDE_STEPS.map((_, i) => String(i + 1)),
    currentProgressStep: index,
    confirmButtonText: last ? (needsTopics ? 'Pick my topics' : 'Done') : 'Next',
    showDenyButton: index > 0,
  };
}

type Modality = 'key' | 'mouse' | 'touch';

/**
 * Runs the guide from step 1 and resolves when it ends. Next and Back move between steps; Skip,
 * Escape and Done end it, and so does the browser's Back. The app is put back on the screen it
 * started from at the end, unless the person has already navigated away from it.
 */
export async function runGuide(run: GuideRun): Promise<void> {
  const startHash = location.hash;
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const startedInSettings = /^#\/settings/.test(startHash);
  const last = GUIDE_STEPS.length - 1;
  let index = 0;
  let toTopics = false;
  let closed = false;
  let busy = false;
  let navigatedAway = false;
  let confirmed = false;
  const needsTopics = run.needsTopics();
  const gone = () => navigatedAway || closed;

  // The browser's Back (and Android's Back, and the app's back button) while the guide is up moves
  // the app to another screen. The guide ends as skipped and leaves that screen and its history
  // alone. The guide's own replaceState calls never fire popstate.
  const onPop = () => {
    navigatedAway = true;
    if (Swal.isVisible()) Swal.close();
  };

  // How the person last interacted: focus on a button is shown with a ring only for the keyboard.
  let modality: Modality = 'key';
  try {
    if (window.matchMedia('(pointer: coarse)').matches) modality = 'touch';
  } catch {
    // Keep the keyboard default.
  }
  const onPointer = (e: PointerEvent) => {
    modality = e.pointerType === 'touch' ? 'touch' : 'mouse';
  };
  const onKey = () => {
    modality = 'key';
  };

  // Keeps focus in the dialog. A keyboard user lands on Next. After a touch or a click the dialog
  // itself takes focus, which names it to a screen reader without drawing a ring on a button.
  const settle = (opening: boolean) => {
    const popup = Swal.getPopup();
    if (!popup || gone()) return;
    const active = document.activeElement;
    const onButton = active instanceof HTMLElement && active !== popup && popup.contains(active);
    if (modality === 'key') {
      if (!onButton) Swal.getConfirmButton()?.focus({ preventScroll: true });
    } else if (opening || !onButton) {
      popup.focus({ preventScroll: true });
    }
  };

  // Moves to the next or previous step: the screen first, then the dialog's words, in the same
  // dialog. Taps on Next and Back while a step is changing are ignored.
  const move = (delta: 1 | -1) => {
    if (busy || gone()) return;
    busy = true;
    index = Math.min(last, Math.max(0, index + delta));
    const step = GUIDE_STEPS[index];
    void showScreen(step, run.tabParams(step.tab), gone)
      .then(() => {
        if (gone()) return;
        Swal.update(stepOptions(index, needsTopics));
        settle(false);
      })
      .finally(() => {
        busy = false;
      });
  };

  window.addEventListener('popstate', onPop);
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  try {
    await showScreen(GUIDE_STEPS[0], run.tabParams(GUIDE_STEPS[0].tab), gone);
    if (!navigatedAway) {
      const result = await Swal.fire({
        ...stepOptions(0, needsTopics),
        position: 'bottom',
        showConfirmButton: true,
        denyButtonText: 'Back',
        showCancelButton: true,
        cancelButtonText: 'Skip',
        // Skip, Back, Next in the page order and the Tab order.
        reverseButtons: true,
        // Next and Back change the step inside this dialog, which stays open; only Done closes it.
        preConfirm: () => {
          if (index < last) {
            move(1);
            return false;
          }
          if (busy) return false;
          toTopics = needsTopics;
          return true;
        },
        preDeny: () => {
          move(-1);
          return false;
        },
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
          container: 'caddie-guide',
          popup: 'caddie-guide-popup',
          title: 'caddie-guide-title',
          htmlContainer: 'caddie-guide-text',
          actions: 'caddie-guide-actions',
          confirmButton: 'btn btn-primary',
          denyButton: 'btn btn-tonal',
          cancelButton: 'btn btn-text',
        },
        didOpen: () => {
          run.onShown?.();
          // After Swal's own first focus.
          window.setTimeout(() => settle(true), 0);
        },
        didRender: (popup: HTMLElement) => {
          // Swal sets the position once; the Settings step moves the dialog to the top.
          const top = GUIDE_STEPS[index].position === 'top';
          const container = popup.parentElement;
          container?.classList.toggle('swal2-top', top);
          container?.classList.toggle('swal2-bottom', !top);
          container?.classList.toggle('caddie-guide-top', top);
          // The dots are a picture. The position is already spoken in the title, so a screen
          // reader should not read them as a list of numbers.
          popup.querySelector('.swal2-progress-steps')?.setAttribute('aria-hidden', 'true');
          // A change of step is announced.
          Swal.getTitle()?.setAttribute('aria-live', 'polite');
        },
        didClose: () => {
          closed = true;
        },
      });
      confirmed = result.isConfirmed;
    }
  } finally {
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    if (Swal.isVisible()) Swal.close();
    run.onEnd(confirmed ? 'done' : 'skipped');
    if (!navigatedAway) {
      replaceHash(startHash);
      if (toTopics) location.hash = '#/profile';
      await frames(3);
      if (toTopics) {
        // Land on the topic pickers, with the cursor in the first one's search field.
        const picker = await findElement('section.pp-picker', () => false);
        picker?.scrollIntoView({ block: 'start' });
        const field = picker?.querySelector<HTMLElement>('input[type="search"]');
        if (field) field.focus({ preventScroll: true });
        else {
          const main = document.getElementById('main');
          if (main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
          main?.focus({ preventScroll: true });
        }
      } else {
        // Focus goes back where it was; if that element was rebuilt, to the Settings help button
        // when the guide started there, and otherwise to the start of the page content.
        const target =
          origin?.isConnected
            ? origin
            : startedInSettings
              ? document.querySelector<HTMLElement>('[data-guide-help]')
              : document.getElementById('main');
        if (target) {
          if (target.id === 'main' && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
      }
    }
  }
}
