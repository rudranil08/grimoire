// Applies the saved theme before first paint (external file: the CSP blocks inline scripts).
// With no saved choice, follow the OS: light mode gets the Bone Paper theme.
try {
  const t = JSON.parse(localStorage.getItem("grimoire.prefs.v1"))?.theme;
  if (t) document.documentElement.dataset.theme = t;
  else if (t === undefined && matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "bone";
} catch { /* no saved theme */ }
