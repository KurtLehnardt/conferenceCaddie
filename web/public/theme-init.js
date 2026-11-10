// Runs first, before the app and before first paint. It is an external file because the
// Content-Security-Policy forbids inline scripts.
(function () {
  // Framing guard. A <meta> Content-Security-Policy cannot carry frame-ancestors, so a page served
  // from GitHub Pages could be framed by any site that then tricks a tap on a visibility or
  // sharing switch. When this page is not the top window, hide it and try to take over the tab.
  // Cloud Run also sends the frame-ancestors header; this is harmless there.
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = 'none';
      try {
        window.top.location = window.self.location.href;
      } catch (e) {
        // A sandboxed or cross-origin parent can refuse the navigation; the page stays hidden.
      }
    }
  } catch (e) {
    // Reading window.top never throws in browsers, but if it does, fail closed.
    document.documentElement.style.display = 'none';
  }

  // Applies the saved theme.
  try {
    var theme = localStorage.getItem('caddie.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {
    // Storage can be unavailable (private mode); the system theme applies.
  }
})();
