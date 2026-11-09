// Applies the saved theme before first paint. It is an external file because
// the Content-Security-Policy forbids inline scripts.
(function () {
  try {
    var theme = localStorage.getItem('caddie.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (e) {
    // Storage can be unavailable (private mode); the system theme applies.
  }
})();
