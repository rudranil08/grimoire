// Log in / sign up page. Mode comes from the URL (/login or /signup); on success we go to ?next= (same-site only).
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("authForm"), user = $("username"), pass = $("password"), err = $("error"), submit = $("submit");

  // Only allow redirects to paths on this site (no "//evil.com" or absolute URLs).
  const nextParam = new URLSearchParams(location.search).get("next") || "/app";
  const next = /^\/(?!\/)[\w\-./?=&#%]*$/.test(nextParam) ? nextParam : "/app";

  let mode = location.pathname.startsWith("/signup") ? "signup" : "login";

  const COPY = {
    login: {
      title: "Log in — Grimoire", kicker: "Members only", heading: "Enter the <em>Grimoire</em>",
      sub: "Welcome back. The tasks have been waiting.", submit: "Enter",
      switch: 'New here? <a href="/signup" data-mode="signup">Join the coven</a>',
    },
    signup: {
      title: "Sign up — Grimoire", kicker: "Free · no email needed", heading: "Join the <em>coven</em>",
      sub: "Pick a name and a password. Your first tasks are already waiting inside.", submit: "Create my account",
      switch: 'Already a member? <a href="/login" data-mode="login">Log in</a>',
    },
  };

  function setMode(m, push) {
    mode = m;
    const c = COPY[m];
    document.title = c.title;
    $("kicker").textContent = c.kicker;
    $("heading").innerHTML = c.heading; // static copy above, never user input
    $("sub").textContent = c.sub;
    submit.textContent = c.submit;
    $("switch").innerHTML = c.switch;
    const signup = m === "signup";
    $("nameHint").hidden = !signup;
    $("passHint").hidden = !signup;
    $("strength").hidden = !signup;
    pass.autocomplete = signup ? "new-password" : "current-password";
    err.textContent = "";
    if (push) history.replaceState(null, "", `/${m}${location.search}`);
  }

  $("switch").addEventListener("click", (e) => {
    const a = e.target.closest("[data-mode]");
    if (!a) return;
    e.preventDefault();
    setMode(a.dataset.mode, true);
    user.focus();
  });

  $("reveal").addEventListener("click", () => {
    const show = pass.type === "password";
    pass.type = show ? "text" : "password";
    $("reveal").textContent = show ? "Hide" : "Show";
    $("reveal").setAttribute("aria-pressed", String(show));
    $("reveal").setAttribute("aria-label", show ? "Hide password" : "Show password");
    pass.focus();
  });

  // Rough strength meter: length plus character variety.
  pass.addEventListener("input", () => {
    const v = pass.value;
    let score = 0;
    if (v.length >= 8) score++;
    if (v.length >= 12) score++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
    if (/\d/.test(v) && /[^\w]/.test(v)) score++;
    if (v.length >= 16) score = Math.max(score, 3);
    $("strength").dataset.score = String(v ? Math.max(1, Math.min(4, score)) : 0);
    pass.removeAttribute("aria-invalid");
  });
  user.addEventListener("input", () => user.removeAttribute("aria-invalid"));

  function fail(message, field) {
    err.textContent = message;
    if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
    form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const username = user.value.trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,24}$/.test(username)) return fail("Names are 3–24 letters, numbers, _ or -.", user);
    if (pass.value.length < 8) return fail("Passwords need at least 8 characters.", pass);

    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = mode === "signup" ? "Summoning…" : "Opening the crypt…";
    try {
      const res = await fetch(`/api/auth/${mode === "signup" ? "register" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: pass.value }),
        credentials: "same-origin",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const field = res.status === 409 || res.status === 401 ? (res.status === 409 ? user : pass) : null;
        return fail(body.error || "Something went wrong. Try again.", field);
      }
      pass.value = "";
      location.replace(next);
    } catch {
      fail("Can't reach the server. Check your connection and try again.");
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });

  // Already signed in? Skip straight to the app.
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .then(({ user }) => { if (user) location.replace(next); })
    .catch(() => {});

  setMode(mode, false);
  user.focus();
})();
