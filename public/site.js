// Public site helpers: swap calls-to-action for signed-in visitors, and reveal sections on scroll.
(async () => {
  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  // Signed in already? Point every CTA at the app instead of sign-up.
  try {
    const { user } = await (await fetch("/api/auth/session", { credentials: "same-origin" })).json();
    if (user) {
      document.querySelectorAll("[data-guest]").forEach((el) => (el.hidden = true));
      document.querySelectorAll("[data-member]").forEach((el) => (el.hidden = false));
    }
  } catch { /* offline: keep guest links */ }

  const items = document.querySelectorAll(".rise");
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.12 });
  items.forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 70}ms`; io.observe(el); });
})();
