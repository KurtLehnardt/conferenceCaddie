import { render } from 'preact';
import { App } from './app';
import './styles.css';
import { registerServiceWorker } from './offline/status';
import { installNativeApiOrigin, isNative } from './native';

async function boot() {
  // The condition is static, so production builds drop the mock module entirely.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const mock = await import('./mock/handler');
    mock.installMockFetch();
  }
  // Android companion only: /api calls go to the production origin. A no-op on the web.
  installNativeApiOrigin();
  render(<App />, document.getElementById('app')!);
  // Production only: the offline shell and the saved schedules. Dev and mock mode skip it, and so
  // does the Android app, whose pages come from the bundle rather than a worker.
  if (!isNative()) registerServiceWorker(import.meta.url);
}

boot();
