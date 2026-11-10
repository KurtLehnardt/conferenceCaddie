// Capacitor shell for the Android companion. The built PWA (web/dist) is bundled into the app;
// there is no server.url, so the WebView never loads the app from the network. API calls go to the
// production origin named by VITE_API_ORIGIN at build time (see src/native.ts), through
// CapacitorHttp so they leave from the native layer: no CORS preflight, no Origin header, and the
// server's same-origin check sees them like a curl call.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.conferencecaddie',
  appName: 'Conference Caddie',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
