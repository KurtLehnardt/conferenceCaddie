import { render } from 'preact';
import { App } from './app';
import './styles.css';

async function boot() {
  // The condition is static, so production builds drop the mock module entirely.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
    const mock = await import('./mock/handler');
    mock.installMockFetch();
  }
  render(<App />, document.getElementById('app')!);
}

boot();
