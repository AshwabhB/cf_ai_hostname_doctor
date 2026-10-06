// Applies the saved light or dark theme before the app renders. A file rather than an
// inline script, so the Content-Security-Policy can stay at script-src 'self'.
(function () {
  var mode = "light";
  try {
    mode = localStorage.getItem("theme") === "dark" ? "dark" : "light";
  } catch (e) {
    // Storage can be unavailable. Light is the default.
  }
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
})();
