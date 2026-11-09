// The Android companion (Capacitor). The same web app is bundled into the app; these two helpers
// are the only things the shell does differently there. On the web they are no-ops.
import { Capacitor } from '@capacitor/core';

/** True inside the Capacitor app; false in any browser, including the installed PWA. */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * In the app the page is served from the bundle, so a relative `/api/...` URL would point at
 * nothing. When VITE_API_ORIGIN is set at build time and the app runs natively, every `/api/`
 * fetch is sent to that origin instead; CapacitorHttp then carries it in the native layer, so
 * there is no CORS preflight and no Origin header. Nothing changes for the web build: without the
 * variable this installs nothing, and the api modules keep calling fetch with relative paths.
 */
export function installNativeApiOrigin(): void {
  const origin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/+$/, '');
  if (!origin || !isNative() || typeof window === 'undefined') return;
  const inner = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('/') ? url : url.startsWith(location.origin) ? url.slice(location.origin.length) : null;
    if (path && path.startsWith('/api/')) {
      if (typeof input === 'string' || input instanceof URL) return inner(origin + path, init);
      return inner(new Request(origin + path, input), init);
    }
    return inner(input, init);
  };
}
