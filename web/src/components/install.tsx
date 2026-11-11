import { useEffect, useRef, useState } from 'preact/hooks';
import { Download, Share, SquarePlus, X } from 'lucide-preact';

// Install onboarding. The card is offered once per device, after the first talk the person marks
// as Interested, and again only when they ask for it from Settings. It never appears when the app
// already runs as an installed app.

const OFFERED_KEY = 'caddie.install.offered.v1';
const OPEN_EVENT = 'caddie:install-open';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The browser fires beforeinstallprompt once, early, so it is captured at module load.
let deferred: InstallPromptEvent | null = null;
let installed = false;
const waiting = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    waiting.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    waiting.forEach((fn) => fn());
  });
}

export function isStandalone(): boolean {
  try {
    return (
      installed ||
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function wasOffered(): boolean {
  try {
    return localStorage.getItem(OFFERED_KEY) === '1';
  } catch {
    return false;
  }
}

function markOffered(): void {
  try {
    localStorage.setItem(OFFERED_KEY, '1');
  } catch {
    // Without storage the card may show again on the next visit, which is harmless.
  }
}

/** Called when a talk is marked Interested. Opens the card only the first time on this device. */
export function offerInstallOnce(): void {
  if (isStandalone() || wasOffered()) return;
  markOffered();
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Called from Settings. Opens the card again, even if it was shown or dismissed before. */
export function openInstallCard(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function InstallCard() {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const region = useRef<HTMLDivElement>(null);

  // While the card is open it floats over the bottom of every screen, so the page reserves its
  // height as extra scroll room (styles.css, [data-install-open]). Otherwise the last controls
  // of a page, such as "Delete my profile", would sit under the card even at full scroll.
  useEffect(() => {
    const el = region.current;
    const doc = document.documentElement;
    if (!open || !el) return;
    const measure = () => doc.style.setProperty('--install-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    measure();
    doc.setAttribute('data-install-open', '');
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      doc.removeAttribute('data-install-open');
      doc.style.removeProperty('--install-h');
    };
  }, [open]);

  useEffect(() => {
    const show = () => {
      if (!isStandalone()) setOpen(true);
    };
    const refresh = () => {
      if (installed) setOpen(false);
      bump((n) => n + 1);
    };
    window.addEventListener(OPEN_EVENT, show);
    waiting.add(refresh);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      waiting.delete(refresh);
    };
  }, []);

  if (!open) return null;

  const ios = isIos();
  const close = () => setOpen(false);
  const install = async () => {
    const e = deferred;
    if (!e) return;
    deferred = null;
    try {
      await e.prompt();
      await e.userChoice;
    } catch {
      // The browser declined to show the prompt; the card simply closes.
    }
    close();
  };

  return (
    <div class="install-region" ref={region}>
      <section class="install-card" role="region" aria-label="Add Conference Caddie to your home screen">
        <button type="button" class="icon-btn install-close" aria-label="Dismiss" onClick={close}>
          <X size={20} aria-hidden="true" />
        </button>
        <h2 class="install-title">Keep Conference Caddie on your home screen</h2>
        {ios ? (
          <>
            <p class="install-body">It opens faster and your Interested list stays on this phone.</p>
            <ol class="install-steps">
              <li>
                <Share size={18} aria-hidden="true" />
                <span>
                  Tap <strong>Share</strong> in the browser toolbar.
                </span>
              </li>
              <li>
                <SquarePlus size={18} aria-hidden="true" />
                <span>
                  Then tap <strong>Add to Home Screen</strong>.
                </span>
              </li>
            </ol>
          </>
        ) : deferred ? (
          <>
            <p class="install-body">It opens faster and your Interested list stays on this phone.</p>
            <button type="button" class="btn btn-primary" onClick={install}>
              <Download size={18} aria-hidden="true" />
              Install
            </button>
          </>
        ) : (
          <p class="install-body">
            Menu, then <strong>Add to Home screen</strong>. It opens faster and your Interested list stays on this phone.
          </p>
        )}
        <button type="button" class="btn btn-text install-later" onClick={close}>
          Not now
        </button>
      </section>
    </div>
  );
}
