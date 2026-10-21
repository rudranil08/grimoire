/* =========================================================
   Grimoire — app logic
   ========================================================= */
(() => {
  "use strict";

  const STORAGE_KEY = "grimoire.tasks.v1";
  const PREFS_KEY = "grimoire.prefs.v1";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PRIORITY = {
    whisper: { label: "Whisper", rank: 0 },
    howl: { label: "Howl", rank: 1 },
    scream: { label: "Scream", rank: 2 },
  };
  const REPEAT_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
  const TAGS = {
    crypt: "🕯️ Crypt",
    ledger: "📜 Ledger",
    cauldron: "🧪 Cauldron",
    coven: "🦇 Coven",
    errand: "🧹 Broom",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const els = {
    list: $("#taskList"),
    tpl: $("#taskTpl"),
    form: $("#composer"),
    input: $("#taskInput"),
    tag: $("#tagInput"),
    due: $("#dueInput"),
    search: $("#searchInput"),
    sort: $("#sortInput"),
    tabs: $$(".tab"),
    glider: $(".tab-glider"),
    empty: $("#emptyState"),
    emptyTitle: $("#emptyTitle"),
    emptyText: $("#emptyText"),
    toast: $("#toast"),
    toastText: $("#toastText"),
    toastUndo: $("#toastUndo"),
    fx: $("#fx"),
    ringFill: $("#ringFill"),
    lantern: $("#lantern"),
    pctNum: $("#pctNum"),
    soulCaption: $("#soulCaption"),
    soulCard: $(".soul"),
    soulSub: $("#soulSub"),
    realmList: $("#realmList"),
    realmClear: $("#realmClear"),
    quickstart: $("#quickstart"),
    calendar: $("#calendar"),
    statsHost: $("#statsView"),
    composerCard: $("#composer"),
    soundToggle: $("#soundToggle"),
  };

  /* ---------------- storage ---------------- */
  const safeGet = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const safeSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } };

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const dayOffset = (n) => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return toISODate(d);
  };
  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const seed = () => [
    { title: "Carve the jack-o'-lantern for the porch", priority: "howl", tag: "crypt", due: dayOffset(2) },
    { title: "Finish the costume — stitch the cape hem", priority: "scream", tag: "cauldron", due: dayOffset(1) },
    { title: "Buy 3 bags of candy (and hide one from myself)", priority: "whisper", tag: "errand", due: dayOffset(4) },
    { title: "Send invites for the midnight séance", priority: "howl", tag: "coven", due: dayOffset(3) },
    { title: "Submit the quarterly report before it haunts me", priority: "scream", tag: "ledger", due: dayOffset(-1) },
    { title: "Hang cobwebs across the hallway", priority: "whisper", tag: "crypt", due: "", done: true },
  ].map((t, i) => ({ id: uid(), done: false, createdAt: Date.now() - i * 1000, completedAt: t.done ? Date.now() : null, order: i, ...t }));

  let tasks = [];
  const prefs = { filter: "all", sort: "manual", sound: false, ...(safeGet(PREFS_KEY) ?? {}) };
  // theme-boot.js may have picked Bone Paper from the OS light-mode setting; reflect that until the user chooses.
  if (prefs.theme === undefined && document.documentElement.dataset.theme) prefs.theme = document.documentElement.dataset.theme;
  const save = () => safeSet(STORAGE_KEY, tasks); // local cache, also the offline store
  const savePrefs = () => safeSet(PREFS_KEY, prefs);

  /* ---------------- server sync ---------------- */
  // The API is the source of truth when reachable. Every change goes through one ordered queue
  // (persisted to localStorage), so writes never race each other and survive going offline.
  const QUEUE_KEY = "grimoire.queue.v1";
  const queue = safeGet(QUEUE_KEY) ?? [];
  const syncEl = $("#sync");
  const sync = { online: false };
  let draining = false;

  function setSync() {
    const state = !sync.online ? "offline" : queue.length ? "saving" : "online";
    syncEl.dataset.state = state;
    syncEl.title = {
      online: "Saved to the crypt (server)",
      saving: "Saving…",
      offline: queue.length ? `Offline — ${queue.length} change${queue.length === 1 ? "" : "s"} waiting to sync` : "Offline — saved in this browser",
    }[state];
    $(".sync-label", syncEl).textContent = { online: "Synced", saving: "Saving", offline: queue.length ? `Offline · ${queue.length}` : "Offline" }[state];
  }
  async function request(method, path, body) {
    const res = await fetch("/api" + path, {
      method, headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error((await res.json().catch(() => ({}))).error || res.statusText);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }
  // Records an already-applied local change and ships it to the server in order.
  function persist(method, path, body) {
    save();
    queue.push({ method, path, body });
    safeSet(QUEUE_KEY, queue);
    setSync();
    drain();
  }
  async function drain() {
    if (draining || !sync.online) return;
    draining = true;
    while (queue.length && sync.online) {
      const op = queue[0];
      try {
        await request(op.method, op.path, op.body);
      } catch (err) {
        if (err.status === 401) { // session expired: keep the change and ask the user to log in again
          sync.online = false;
          showAuth("Your session expired — log in again and your changes will sync.").then((u) => { currentUser = u; adoptUser(u); reconnect(); });
          break;
        }
        if (err.status === 429 || err.status >= 500) { // throttled or server hiccup: keep it and retry shortly
          draining = false;
          setTimeout(drain, err.status === 429 ? 5000 : 3000);
          setSync();
          return;
        }
        if (err instanceof TypeError) { // network failure: keep the change, retry on reconnect
          sync.online = false;
          showToast("Lost contact with the crypt — changes will sync when it returns.", false);
          break;
        }
        console.warn("Server rejected a change; dropping it:", op, err.message);
      }
      queue.shift();
      safeSet(QUEUE_KEY, queue);
    }
    draining = false;
    setSync();
  }
  async function reconnect() {
    if (sync.online) return;
    try { await request("GET", "/health"); } catch { return; }
    sync.online = true;
    await drain();
    if (!sync.online) return;
    try { tasks = await request("GET", "/tasks"); save(); render(); } catch { /* keep local */ }
    await syncTrophies();
    setSync();
    showToast("Back in contact with the crypt — everything synced.", false);
  }
  setInterval(reconnect, 8000);
  window.addEventListener("online", reconnect);
  window.addEventListener("focus", reconnect);
  async function load() {
    try {
      await request("GET", "/health");
    } catch {
      return loadOffline();
    }
    // Server is up: make sure we know who is using it.
    try {
      currentUser = (await request("GET", "/auth/me")).user;
    } catch (err) {
      if (err.status !== 401) return loadOffline();
      currentUser = await showAuth();
    }
    adoptUser(currentUser);
    try {
      sync.online = true;
      await drain(); // replay changes made while offline on a previous visit
      tasks = await request("GET", "/tasks");
      await syncTrophies();
      customSpells = await request("GET", "/spells").catch(() => []);
    } catch {
      return loadOffline();
    }
    save(); setSync();
  }
  function loadOffline() {
    tasks = safeGet(STORAGE_KEY) ?? seed();
    sync.online = false;
    save(); setSync();
  }

  /* ---------------- accounts ---------------- */
  const USER_KEY = "grimoire.user.v1";
  let currentUser = null;
  // Local caches belong to one account: switching accounts wipes them so nothing leaks across.
  function adoptUser(user) {
    const prev = safeGet(USER_KEY);
    if (prev && prev !== user.id) {
      for (const k of [STORAGE_KEY, QUEUE_KEY, STATS_KEY]) { try { localStorage.removeItem(k); } catch {} }
      queue.length = 0;
      Object.assign(trophyState, { slain: 0, unlocked: {}, days: [], focusMin: 0, log: {} });
    }
    safeSet(USER_KEY, user.id);
    $("#userName").textContent = user.username;
    $("#userBtn").hidden = false;
    $("#icsLink").href = `/api/calendar.ics?token=${encodeURIComponent(user.feedToken)}`;
    $("#shareBtn").textContent = user.shareToken ? "🔗 Copy share link" : "🔗 Share a read-only poster";
    $("#unshareBtn").hidden = !user.shareToken;
  }

  // Shows the login / sign-up screen; resolves with the user once they're in.
  function showAuth(message) {
    const el = $("#auth"), form = $("#authForm"), err = $("#authError");
    let mode = "login";
    const setMode = (m) => {
      mode = m;
      $$(".auth-tab", el).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
      $("#authSubmit").textContent = m === "login" ? "Enter" : "Join the coven";
      $("#authPass").autocomplete = m === "login" ? "current-password" : "new-password";
      $("#authHint").hidden = m === "login";
      err.textContent = "";
    };
    el.hidden = false;
    document.body.classList.add("auth-on");
    err.textContent = message || "";
    setMode("login");
    $("#authUser").focus();
    return new Promise((resolve) => {
      $$(".auth-tab", el).forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
      form.onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = "";
        $("#authSubmit").disabled = true;
        try {
          const { user, claimed } = await request("POST", `/auth/${mode === "login" ? "login" : "register"}`, {
            username: $("#authUser").value, password: $("#authPass").value,
          });
          $("#authPass").value = "";
          el.hidden = true;
          document.body.classList.remove("auth-on");
          if (claimed) setTimeout(() => showToast(`Welcome, ${user.username}. ${claimed} existing task${claimed === 1 ? " is" : "s are"} now yours.`, false), 600);
          resolve(user);
        } catch (e2) {
          err.textContent = e2 instanceof TypeError ? "The crypt is unreachable. Is the server running?" : e2.message;
          form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
        } finally {
          $("#authSubmit").disabled = false;
        }
      };
    });
  }

  async function logout() {
    try { await request("POST", "/auth/logout"); } catch { /* already gone */ }
    for (const k of [STORAGE_KEY, QUEUE_KEY, STATS_KEY, USER_KEY]) { try { localStorage.removeItem(k); } catch {} }
    location.reload();
  }
  $("#userBtn").addEventListener("click", () => {
    const menu = $("#userMenu");
    menu.hidden = !menu.hidden;
    $("#userBtn").setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#userBtn, #userMenu")) { $("#userMenu").hidden = true; $("#userBtn").setAttribute("aria-expanded", "false"); }
  });
  $("#logoutBtn").addEventListener("click", logout);
  $("#logoutAll").addEventListener("click", async () => {
    $("#userMenu").hidden = true;
    if (!confirm("Sign out of Grimoire on every device, including this one?")) return;
    try { await request("POST", "/auth/logout-all"); } catch { /* fall through to local sign-out */ }
    for (const k of [STORAGE_KEY, QUEUE_KEY, STATS_KEY, USER_KEY]) { try { localStorage.removeItem(k); } catch {} }
    location.reload();
  });

  // Account settings dialog: change password / delete account (both re-check the current password).
  function openAcct(mode) {
    $("#userMenu").hidden = true;
    const el = $("#acct"), err = $("#acctError");
    const del = mode === "delete";
    $("#acctTitle").innerHTML = del ? "Delete <em>account</em>" : "Change <em>password</em>";
    $("#acctText").textContent = del
      ? `This destroys ${currentUser.username}'s tasks, graveyard and trophies forever. There is no undo.`
      : "Every other device will be signed out.";
    $("#acctNewWrap").hidden = del;
    $("#acctSubmit").textContent = del ? "Destroy everything" : "Change password";
    $("#acctPass").value = ""; $("#acctNew").value = ""; err.textContent = "";
    el.hidden = false;
    $("#acctPass").focus();
    const close = () => { el.hidden = true; $("#userBtn").focus(); };
    $("#acctCancel").onclick = close;
    el.onkeydown = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    $("#acctForm").onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      $("#acctSubmit").disabled = true;
      try {
        if (del) {
          await request("DELETE", "/auth/account", { password: $("#acctPass").value });
          for (const k of [STORAGE_KEY, QUEUE_KEY, STATS_KEY, USER_KEY]) { try { localStorage.removeItem(k); } catch {} }
          location.reload();
          return;
        }
        await request("POST", "/auth/password", { password: $("#acctPass").value, newPassword: $("#acctNew").value });
        close();
        showToast("Password changed. Other devices have been signed out.", false);
      } catch (e2) {
        err.textContent = e2.message;
        $("#acctForm").classList.remove("shake"); void $("#acctForm").offsetWidth; $("#acctForm").classList.add("shake");
      } finally {
        $("#acctPass").value = ""; $("#acctNew").value = "";
        $("#acctSubmit").disabled = false;
      }
    };
  }
  /* ---------------- reminders (browser notifications) ---------------- */
  // While the app is open, nudge once per day about tasks due today or overdue.
  const REMIND_KEY = "grimoire.reminded.v1";
  function setRemindLabel() {
    const on = !!prefs.remind && "Notification" in window && Notification.permission === "granted";
    $("#remindToggle").setAttribute("aria-checked", String(on));
    $("#remindToggle b").textContent = on ? "on" : "off";
  }
  async function toggleReminders() {
    if (!("Notification" in window)) { showToast("This browser can't show notifications.", false); return; }
    if (prefs.remind) { prefs.remind = false; savePrefs(); setRemindLabel(); showToast("Reminders off.", false); return; }
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (perm !== "granted") { showToast("Notifications are blocked for this site — allow them in your browser settings.", false); return; }
    prefs.remind = true; savePrefs(); setRemindLabel();
    safeSet(REMIND_KEY, null); // remind straight away
    remindIfDue();
    showToast("Reminders on — you'll be nudged once a day while Grimoire is open.", false);
  }
  function remindIfDue() {
    if (!prefs.remind || !("Notification" in window) || Notification.permission !== "granted") return;
    const today = toISODate(new Date());
    if (safeGet(REMIND_KEY) === today) return;
    const due = tasks.filter(isTonight);
    if (!due.length) return;
    safeSet(REMIND_KEY, today);
    const names = due.slice(0, 3).map((t) => t.title).join(", ") + (due.length > 3 ? ` +${due.length - 3} more` : "");
    try {
      const n = new Notification(`🎃 ${due.length} task${due.length === 1 ? "" : "s"} haunt${due.length === 1 ? "s" : ""} you today`, { body: names, icon: "/icon.svg", tag: "grimoire-due" });
      n.onclick = () => { window.focus(); setView("list"); setFilter("tonight"); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
  $("#remindToggle").addEventListener("click", () => { $("#userMenu").hidden = true; toggleReminders(); });
  setInterval(remindIfDue, 30 * 60 * 1000);

  // Read-only public poster of your live list.
  $("#shareBtn").addEventListener("click", async () => {
    $("#userMenu").hidden = true;
    try {
      if (!currentUser.shareToken) {
        if (!confirm("Create a public read-only link to your task titles, dates and dread levels? (Notes and checklists stay private.)")) return;
        currentUser = (await request("POST", "/auth/share", { enabled: true })).user;
        adoptUser(currentUser);
      }
      const url = `${location.origin}/share.html#${currentUser.shareToken}`;
      try { await navigator.clipboard.writeText(url); showToast("Share link copied — anyone with it can see your poster.", false); }
      catch { prompt("Your share link:", url); }
    } catch (e) { showToast(`Couldn't share: ${e.message}`, false); }
  });
  $("#unshareBtn").addEventListener("click", async () => {
    $("#userMenu").hidden = true;
    try {
      currentUser = (await request("POST", "/auth/share", { enabled: false })).user;
      adoptUser(currentUser);
      showToast("Poster taken down — the old link no longer works.", false);
    } catch (e) { showToast(`Couldn't stop sharing: ${e.message}`, false); }
  });

  $("#changePass").addEventListener("click", () => openAcct("password"));
  $("#deleteAcct").addEventListener("click", () => openAcct("delete"));
  $("#rotateFeed").addEventListener("click", async () => {
    $("#userMenu").hidden = true;
    if (!confirm("Make a new calendar feed URL? Calendars subscribed to the old one will stop updating.")) return;
    try {
      currentUser = (await request("POST", "/auth/feed-token")).user;
      adoptUser(currentUser);
      showToast("New calendar feed URL ready — use “Copy calendar feed URL”.", false);
    } catch (e) { showToast(`Couldn't rotate the feed: ${e.message}`, false); }
  });
  $("#copyFeed").addEventListener("click", async () => {
    const url = new URL($("#icsLink").getAttribute("href"), location.href).href;
    try { await navigator.clipboard.writeText(url); showToast("Calendar feed URL copied — paste it into your calendar app's “subscribe” option.", false); }
    catch { prompt("Copy your private calendar feed URL:", url); }
    $("#userMenu").hidden = true;
  });

  /* ---------------- rendering ---------------- */
  // "Tonight": unfinished and due today or earlier.
  const isTonight = (t) => !t.done && !!t.due && t.due <= toISODate(new Date());

  // Search with operators: is:done|open|late|today|repeat  !scream|!howl|!whisper  #work|#home…  due:today|tomorrow|week|none
  const REALM_ALIASES = { crypt: "crypt", home: "crypt", ledger: "ledger", work: "ledger", cauldron: "cauldron", party: "cauldron",
    coven: "coven", social: "coven", broom: "errand", errand: "errand", errands: "errand" };
  function parseSearch(raw) {
    const preds = [], words = [];
    const today = toISODate(new Date());
    const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return toISODate(d); };
    for (const tok of raw.toLowerCase().split(/\s+/).filter(Boolean)) {
      let m;
      if ((m = tok.match(/^is:(done|vanquished|open|lurking|late|overdue|today|tonight|repeat|repeating)$/))) {
        const k = m[1];
        preds.push(k === "done" || k === "vanquished" ? (t) => t.done
          : k === "open" || k === "lurking" ? (t) => !t.done
          : k === "late" || k === "overdue" ? (t) => !t.done && !!t.due && t.due < today
          : k === "today" || k === "tonight" ? isTonight
          : (t) => !!t.repeat);
      } else if ((m = tok.match(/^!(scream|howl|whisper|s|h|w)$/))) {
        const p = { s: "scream", h: "howl", w: "whisper" }[m[1][0]];
        preds.push((t) => t.priority === p);
      } else if ((m = tok.match(/^#([a-z]+)$/)) && REALM_ALIASES[m[1]]) {
        const tag = REALM_ALIASES[m[1]];
        preds.push((t) => t.tag === tag);
      } else if ((m = tok.match(/^due:(today|tomorrow|week|none)$/))) {
        const k = m[1];
        preds.push(k === "none" ? (t) => !t.due
          : k === "today" ? (t) => t.due === today
          : k === "tomorrow" ? (t) => t.due === inDays(1)
          : (t) => !!t.due && t.due >= today && t.due <= inDays(7));
      } else {
        words.push(tok);
      }
    }
    return { preds, text: words.join(" ") };
  }
  const searchText = () => parseSearch(els.search.value.trim()).text; // free text, for highlighting

  function visibleTasks() {
    const { preds, text: q } = parseSearch(els.search.value.trim());
    let out = tasks.filter((t) =>
      (prefs.filter === "all" || (prefs.filter === "tonight" ? isTonight(t) : prefs.filter === "done" ? t.done : !t.done)) &&
      preds.every((p) => p(t)) &&
      (!q || t.title.toLowerCase().includes(q) || t.notes?.toLowerCase().includes(q) || TAGS[t.tag]?.toLowerCase().includes(q))
    );
    const byOrder = (a, b) => a.order - b.order;
    if (prefs.sort === "due") {
      out.sort((a, b) => (a.due || "9999") .localeCompare(b.due || "9999") || byOrder(a, b));
    } else if (prefs.sort === "priority") {
      out.sort((a, b) => PRIORITY[b.priority].rank - PRIORITY[a.priority].rank || byOrder(a, b));
    } else {
      out.sort(byOrder);
    }
    // Vanquished tasks sink to the bottom in the "All" view
    if (prefs.filter === "all") out.sort((a, b) => Number(a.done) - Number(b.done));
    return out;
  }

  function dueInfo(due) {
    if (!due) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(due + "T00:00:00");
    const diff = Math.round((d - today) / 86400000);
    let text, cls = "";
    if (diff < 0) { text = diff === -1 ? "Overdue · yesterday" : `Overdue · ${-diff}d`; cls = "late"; }
    else if (diff === 0) { text = "Due tonight"; cls = "soon"; }
    else if (diff === 1) { text = "Tomorrow"; cls = "soon"; }
    else if (due.endsWith("-10-31")) { text = "🎃 Halloween"; cls = diff < 2 ? "soon" : ""; }
    else if (diff < 7) { text = d.toLocaleDateString(undefined, { weekday: "long" }); }
    else { text = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    return { text, cls };
  }

  // Renders the title as text nodes, wrapping search matches in <mark> (no innerHTML, so titles stay inert).
  function setTitle(el, title, q) {
    const i = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) { el.textContent = title; return; }
    const mark = document.createElement("mark");
    mark.textContent = title.slice(i, i + q.length);
    el.replaceChildren(title.slice(0, i), mark, title.slice(i + q.length));
  }

  function buildTask(t) {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = t.id;
    node.dataset.priority = t.priority;
    node.classList.toggle("is-done", t.done);
    $(".check", node).setAttribute("aria-label", t.done ? "Mark as not done" : "Mark complete");
    $(".check", node).setAttribute("aria-pressed", String(t.done));
    setTitle($(".task-title", node), t.title, searchText());
    const notesEl = $(".task-notes", node);
    if (t.notes) { notesEl.hidden = false; setTitle(notesEl, t.notes, searchText()); }
    $(".note", node).classList.toggle("has-notes", !!t.notes);
    renderSteps(node, t);
    $(".pill.snooze", node).hidden = !(!t.done && dueInfo(t.due)?.cls === "late");
    node.classList.toggle("due-today", !t.done && t.due === toISODate(new Date()));
    // Cobwebs: unfinished for over a week and not urgent — a gentle nudge.
    const ageDays = Math.floor((Date.now() - (t.createdAt || Date.now())) / 86400000);
    if (!t.done && ageDays >= 7 && !isTonight(t)) {
      node.classList.add("cobwebbed");
      node.title = `Gathering cobwebs — lurking for ${ageDays} days`;
    }
    const fp = $(".pill.focus", node);
    fp.hidden = !(t.focusMin > 0);
    if (t.focusMin > 0) fp.textContent = `⏳ ${t.focusMin >= 60 ? `${Math.floor(t.focusMin / 60)}h ${t.focusMin % 60}m` : `${t.focusMin}m`}`;
    const rp = $(".pill.repeat", node);
    rp.hidden = !t.repeat;
    if (t.repeat) rp.textContent = `↻ ${REPEAT_LABEL[t.repeat]}`;
    $(".pill.prio", node).textContent = PRIORITY[t.priority].label;
    $(".pill.tag", node).textContent = TAGS[t.tag] ?? t.tag;
    const di = dueInfo(t.due);
    const duePill = $(".pill.due", node);
    if (di) {
      duePill.textContent = di.text;
      if (di.cls) duePill.classList.add(di.cls);
    } else {
      duePill.textContent = "+ Date";
      duePill.classList.add("add");
      duePill.setAttribute("aria-label", "Add due date");
    }
    return node;
  }

  // Only tasks that weren't on screen before get the entrance animation (staggered),
  // so typing in search or toggling doesn't make the whole list flicker.
  let shownIds = new Set();
  let firstPaint = true;
  function render() {
    const list = visibleTasks();
    let n = 0;
    const decorate = (t) => {
      const node = buildTask(t);
      if (!shownIds.has(t.id)) {
        node.classList.add("enter");
        node.style.setProperty("--i", firstPaint ? n++ : 0);
      }
      return node;
    };
    // Completed tasks live in their own (collapsible) section below the active ones.
    const activeList = list.filter((t) => !t.done);
    const doneList = list.filter((t) => t.done);
    const nodes = activeList.map(decorate);
    if (doneList.length) {
      const collapsed = prefs.filter === "all" && prefs.hideDone;
      nodes.push(buildSectionHead(doneList.length, collapsed));
      if (!collapsed) nodes.push(...doneList.map(decorate));
    }
    const view = prefs.view || "list";
    const calView = view !== "list"; // any non-list view replaces the task list
    els.list.hidden = calView;
    els.calendar.hidden = view !== "calendar";
    $("#statsView").hidden = view !== "stats";
    els.sort.closest(".chip-select").hidden = calView;
    if (calView) nodes.length = 0;
    if (view === "calendar") renderCalendar(list);
    if (view === "stats") renderStats();
    if (prefs.filter === "tonight" && !calView && activeList.length) {
      const head = document.createElement("li");
      head.className = "section-head tonight-head";
      head.innerHTML = `<span class="sh-toggle" style="cursor:default">☾ Due tonight or overdue</span><span class="sh-rule" aria-hidden="true"></span><button type="button" class="link-btn snooze-all">💤 Snooze all to tomorrow</button>`;
      nodes.unshift(head);
    }
    els.list.replaceChildren(...nodes);
    shownIds = new Set(nodes.map((nd) => nd.dataset.id).filter(Boolean));
    if (list.length) firstPaint = false;
    els.list.classList.toggle("no-drag", prefs.sort !== "manual" || !!els.search.value.trim());

    const done = tasks.filter((t) => t.done).length;
    const active = tasks.length - done;

    // empty state
    // "All clear": everything in view is done — fill the board with a message, finished tasks sit below it.
    const allClear = prefs.filter === "all" && !els.search.value.trim() && list.length > 0 && activeList.length === 0;
    const isEmpty = !calView && (list.length === 0 || allClear);
    els.empty.hidden = !isEmpty;
    els.empty.classList.toggle("on-top", allClear);
    $("#clearSearch").hidden = !(isEmpty && els.search.value.trim());
    if (allClear) { els.emptyTitle.textContent = "All quiet in the graveyard."; els.emptyText.textContent = "Every task is slain. Summon more — or go trick-or-treat."; }
    else if (isEmpty) {
      if (els.search.value.trim()) { els.emptyTitle.textContent = "Nothing stirs…"; els.emptyText.textContent = "No task answers to that name."; }
      else if (prefs.filter === "done") { els.emptyTitle.textContent = "No souls claimed yet"; els.emptyText.textContent = "Vanquish a task and it will rest here."; }
      else if (prefs.filter === "tonight") { els.emptyTitle.textContent = "Nothing haunts you tonight."; els.emptyText.textContent = "No task is due today or overdue. Rest easy… for now."; }
      else if (prefs.filter === "active" && tasks.length) { els.emptyTitle.textContent = "All is quiet."; els.emptyText.textContent = "Every task has been vanquished. Go trick-or-treat."; }
      else { els.emptyTitle.textContent = "Eerily quiet…"; els.emptyText.textContent = "No tasks lurk here. Summon one above."; }
    }

    // counts
    $$("[data-count]").forEach((el) => {
      el.textContent = { all: tasks.length, active, done, tonight: tasks.filter(isTonight).length }[el.dataset.count];
      el.toggleAttribute("data-zero", el.textContent === "0");
    });
    els.quickstart.hidden = tasks.length > 0;
    renderRealms();

    document.title = (active ? `(${active}) ` : "") + "Grimoire — A Haunted Task Ledger";
    updateFavicon(active);

    const screaming = tasks.filter((t) => !t.done && t.priority === "scream").length;
    const overdue = tasks.filter((t) => !t.done && dueInfo(t.due)?.cls === "late").length;
    const bits = [];
    const st = streak();
    if (st >= 2) bits.push(`<b class="f">🔥 ${st}</b>-night streak`);
    if (screaming) bits.push(`<b class="s">${screaming}</b> screaming`);
    if (overdue) bits.push(`<b class="o">${overdue}</b> overdue`);
    if (!bits.length && active) bits.push(`<b>${active}</b> still lurking`);
    els.soulSub.innerHTML = bits.join(" · ");

    updateSoul(done, tasks.length);
    if (selected.size) syncSelection();
  }

  function renderRealms() {
    const q = els.search.value.trim().toLowerCase();
    els.realmList.replaceChildren(...Object.entries(TAGS).map(([key, label]) => {
      const all = tasks.filter((t) => t.tag === key);
      const slain = all.filter((t) => t.done).length;
      const li = document.createElement("li");
      li.innerHTML = `
        <button type="button" class="realm" data-realm="${key}" aria-pressed="${q === label.toLowerCase()}" ${all.length ? "" : "disabled"}>
          <span class="realm-name">${label}</span>
          <span class="realm-num">${slain}<i>/</i>${all.length}</span>
          <span class="realm-bar"><span style="width:${all.length ? (slain / all.length) * 100 : 0}%"></span></span>
        </button>`;
      return li;
    }));
    els.realmClear.hidden = !Object.values(TAGS).some((l) => l.toLowerCase() === q);
  }
  els.realmList.addEventListener("click", (e) => {
    const b = e.target.closest(".realm");
    if (!b) return;
    const label = TAGS[b.dataset.realm];
    els.search.value = els.search.value.trim().toLowerCase() === label.toLowerCase() ? "" : label;
    render();
  });
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!sync.online) { showToast("Importing needs the server — you're offline.", false); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch { showToast("That file isn't valid JSON.", false); return; }
    const n = Array.isArray(data?.tasks) ? data.tasks.length : 0;
    if (!confirm(`Replace ALL current tasks with ${n} task${n === 1 ? "" : "s"} from this backup? This can't be undone.`)) return;
    try {
      const { imported } = await request("POST", "/import", data);
      tasks = await request("GET", "/tasks");
      Object.assign(trophyState, { slain: 0, unlocked: {}, days: [] }, await request("GET", "/trophies"));
      safeSet(STATS_KEY, trophyState); save(); shownIds = new Set(); renderTrophies(); render();
      showToast(`Raised ${imported} task${imported === 1 ? "" : "s"} from the backup.`, false);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, false);
    }
  });
  $("#clearSearch").addEventListener("click", () => { els.search.value = ""; render(); els.input.focus(); });
  els.realmClear.addEventListener("click", () => { els.search.value = ""; render(); });

  els.quickstart.addEventListener("click", (e) => {
    const spell = e.target.closest(".qs-spell");
    if (spell) { castSpell(spell.dataset.spell); return; }
    const c = e.target.closest(".qs-chip");
    if (!c) return;
    els.input.value = c.dataset.title;
    els.tag.value = c.dataset.tag;
    $(`input[name="priority"][value="${c.dataset.priority}"]`).checked = true;
    els.form.requestSubmit();
  });

  /* ---------------- stats view ---------------- */
  function bestStreak() {
    const days = [...new Set(trophyState.days)].sort();
    let best = 0, run = 0, prev = null;
    for (const d of days) {
      const p = prev && new Date(prev + "T00:00"); if (p) p.setDate(p.getDate() + 1);
      run = p && toISODate(p) === d ? run + 1 : 1;
      best = Math.max(best, run); prev = d;
    }
    return best;
  }
  function renderStats() {
    const log = trophyState.log || {};
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d; });
    const counts = days.map((d) => log[toISODate(d)] || 0);
    const max = Math.max(1, ...counts);
    const total14 = counts.reduce((a, b) => a + b, 0);
    const fm = trophyState.focusMin || 0;
    const active = tasks.filter((t) => !t.done);
    const byPrio = Object.keys(PRIORITY).map((p) => [p, active.filter((t) => t.priority === p).length]);
    const realmDone = Object.entries(TAGS).map(([k, label]) => [label, tasks.filter((t) => t.tag === k && t.done).length, tasks.filter((t) => t.tag === k).length]);
    const tiles = [
      ["Slain, all time", trophyState.slain],
      ["Séance time", fm >= 60 ? `${Math.floor(fm / 60)}h ${fm % 60}m` : `${fm}m`],
      ["Current streak", `${streak()}<small> nights</small>`],
      ["Best streak", `${bestStreak()}<small> nights</small>`],
    ].map(([l, v]) => `<div class="st-tile"><span class="st-num">${v}</span><span class="st-lbl">${l}</span></div>`).join("");
    const bars = days.map((d, i) => {
      const iso = toISODate(d), n = counts[i];
      const label = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
      return `<div class="st-bar${i === 13 ? " today" : ""}" title="${label}: ${n} slain">
        <span class="st-bar-n">${n || ""}</span>
        <span class="st-bar-fill" style="height:${(n / max) * 100}%"></span>
        <span class="st-bar-d">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</span></div>`;
    }).join("");
    const prioBar = byPrio.map(([p, n]) => n ? `<span class="pb pb-${p}" style="flex:${n}" title="${PRIORITY[p].label}: ${n}">${n}</span>` : "").join("");
    els.statsHost.innerHTML = `
      <div class="st-tiles">${tiles}</div>
      <section class="st-block">
        <h3 class="st-h">Kill count <small>· last 14 nights · ${total14} slain</small></h3>
        <div class="st-chart" role="img" aria-label="Tasks slain per day for the last 14 days: ${counts.join(", ")}">${bars}</div>
      </section>
      <div class="st-split">
        <section class="st-block">
          <h3 class="st-h">Still lurking <small>· by dread</small></h3>
          ${active.length ? `<div class="prio-bar">${prioBar}</div>
          <p class="st-legend">${byPrio.map(([p, n]) => `<span class="lg lg-${p}">${PRIORITY[p].label} ${n}</span>`).join("")}</p>` : `<p class="st-empty">Nothing lurks. Suspicious.</p>`}
        </section>
        <section class="st-block">
          <h3 class="st-h">Recent kills</h3>
          ${(() => {
            const recent = tasks.filter((t) => t.done && t.completedAt).sort((a, b) => b.completedAt - a.completedAt).slice(0, 5);
            const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
            return recent.length
              ? `<ul class="st-realms">${recent.map((t) => `<li><span>✝ ${esc(truncate(t.title, 30))}</span><b>${ago(t.completedAt)}</b></li>`).join("")}</ul>`
              : `<p class="st-empty">No blood spilled yet.</p>`;
          })()}
        </section>
        <section class="st-block">
          <h3 class="st-h">Most haunted <small>· séance time per task</small></h3>
          ${(() => {
            const top = tasks.filter((t) => t.focusMin > 0).sort((a, b) => b.focusMin - a.focusMin).slice(0, 4);
            return top.length
              ? `<ul class="st-realms">${top.map((t) => `<li><span>${esc(truncate(t.title, 34))}</span><b>${t.focusMin}<i>m</i></b></li>`).join("")}</ul>`
              : `<p class="st-empty">No séances held yet. Press F on a task.</p>`;
          })()}
        </section>
        <section class="st-block">
          <h3 class="st-h">Slain by realm</h3>
          <ul class="st-realms">${realmDone.map(([l, d, t]) => `<li><span>${l}</span><b>${d}<i>/</i>${t}</b></li>`).join("")}</ul>
        </section>
      </div>`;
  }

  /* ---------------- calendar view ---------------- */
  let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function renderCalendar(list) {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const today = toISODate(new Date());
    const byDay = {};
    for (const t of list) if (t.due) (byDay[t.due] ??= []).push(t);
    const undated = list.filter((t) => !t.due && !t.done).length;

    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first grid
    const daysIn = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<div class="cal-cell pad" aria-hidden="true"></div>`);
    for (let d = 1; d <= daysIn; d++) {
      const iso = toISODate(new Date(y, m, d));
      const items = (byDay[iso] ?? []).sort((a, b) => Number(a.done) - Number(b.done) || PRIORITY[b.priority].rank - PRIORITY[a.priority].rank);
      const cls = ["cal-cell", iso === today && "today", iso < today && "past", m === 9 && d === 31 && "hallows", els.due.value === iso && "picked"].filter(Boolean).join(" ");
      const chips = items.slice(0, 3).map((t) =>
        `<button type="button" class="cal-chip p-${t.priority}${t.done ? " done" : ""}" data-id="${t.id}" draggable="true" title="${esc(t.title)} — drag to another day to reschedule">${esc(t.title)}</button>`).join("");
      const more = items.length > 3 ? `<span class="cal-more">+${items.length - 3} more</span>` : "";
      const late = items.some((t) => !t.done && iso < today);
      cells.push(`<div class="${cls}${late ? " late" : ""}" data-day="${iso}" role="button" tabindex="0" aria-label="${new Date(y, m, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}: ${items.length} task${items.length === 1 ? "" : "s"}. Click to add a task on this day.">
        <span class="cal-num">${d}${m === 9 && d === 31 ? " 🎃" : ""}</span>${chips}${more}</div>`);
    }
    const dows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span>${d}</span>`).join("");
    els.calendar.innerHTML = `
      <div class="cal-head">
        <button type="button" class="icon-btn sm cal-nav" data-step="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" class="ico sm"><path d="m15 6-6 6 6 6"/></svg></button>
        <h3 class="cal-title">${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <button type="button" class="icon-btn sm cal-nav" data-step="1" aria-label="Next month"><svg viewBox="0 0 24 24" class="ico sm"><path d="m9 6 6 6-6 6"/></svg></button>
        <button type="button" class="link-btn cal-today">Today</button>
      </div>
      <div class="cal-dows">${dows}</div>
      <div class="cal-grid">${cells.join("")}</div>
      <p class="cal-foot">Click a day to summon a task for it.${undated ? ` · <b>${undated}</b> undated task${undated === 1 ? "" : "s"} live in List view.` : ""}</p>`;
  }

  els.calendar.addEventListener("click", (e) => {
    const nav = e.target.closest(".cal-nav");
    if (nav) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(nav.dataset.step), 1); render(); return; }
    if (e.target.closest(".cal-today")) { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); render(); return; }
    const chip = e.target.closest(".cal-chip");
    if (chip) { setView("list"); setFilter("all"); els.search.value = ""; render(); focusTask(chip.dataset.id); return; }
    const cell = e.target.closest(".cal-cell[data-day]");
    if (cell) pickDay(cell.dataset.day);
  });
  els.calendar.addEventListener("keydown", (e) => {
    const cell = e.target.closest(".cal-cell[data-day]");
    if (cell && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pickDay(cell.dataset.day); }
  });
  // Drag a chip onto another day to reschedule it.
  let calDragId = null;
  els.calendar.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".cal-chip");
    if (!chip) return;
    calDragId = chip.dataset.id;
    chip.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", calDragId);
  });
  els.calendar.addEventListener("dragover", (e) => {
    const cell = e.target.closest(".cal-cell[data-day]");
    if (!calDragId || !cell) return;
    e.preventDefault();
    $$(".cal-cell.drop", els.calendar).forEach((c) => c !== cell && c.classList.remove("drop"));
    cell.classList.add("drop");
  });
  els.calendar.addEventListener("dragleave", (e) => {
    const cell = e.target.closest(".cal-cell");
    if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove("drop");
  });
  els.calendar.addEventListener("drop", (e) => {
    const cell = e.target.closest(".cal-cell[data-day]");
    if (!calDragId || !cell) return;
    e.preventDefault();
    const t = tasks.find((x) => x.id === calDragId);
    calDragId = null;
    if (!t || t.due === cell.dataset.day) { render(); return; }
    remember(`Move “${truncate(t.title, 30)}”`, [{ id: t.id, before: snap(t) }]);
    t.due = cell.dataset.day;
    persist("PATCH", `/tasks/${t.id}`, { due: t.due });
    render();
    showToast(`“${truncate(t.title, 28)}” moved to ${new Date(t.due + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}.`, false);
  });
  els.calendar.addEventListener("dragend", () => {
    calDragId = null;
    $$(".cal-cell.drop, .cal-chip.dragging", els.calendar).forEach((n) => n.classList.remove("drop", "dragging"));
  });

  function pickDay(iso) {
    els.due.value = iso;
    els.due.classList.remove("is-empty");
    render();
    els.input.focus();
    els.input.placeholder = `What must be done by ${new Date(iso + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}?`;
  }

  function setView(v) {
    prefs.view = v; savePrefs();
    $$(".view-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
    render();
  }
  $$(".view-switch button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  function buildSectionHead(count, collapsed) {
    const li = document.createElement("li");
    li.className = "section-head";
    const collapsible = prefs.filter === "all";
    li.innerHTML = `
      <button type="button" class="sh-toggle" ${collapsible ? `aria-expanded="${!collapsed}"` : "disabled"}>
        <svg viewBox="0 0 24 24" class="ico sm chev"><path d="m6 9 6 6 6-6"/></svg>
        <span>Vanquished</span><span class="tab-count">${count}</span>
      </button>
      <span class="sh-rule" aria-hidden="true"></span>
      <button type="button" class="link-btn grave-open">🪦 Graveyard</button>
      <button type="button" class="link-btn bury">Bury all</button>`;
    return li;
  }

  /* ---------------- soul meter ---------------- */
  const CIRC = 2 * Math.PI * 68;
  let lastPct = -1;
  function updateSoul(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    els.ringFill.style.strokeDashoffset = String(CIRC * (1 - pct / 100));
    els.lantern.style.setProperty("--glow", (pct / 100).toFixed(2));
    els.lantern.classList.toggle("lit", pct > 0);
    animateNumber(els.pctNum, lastPct < 0 ? pct : lastPct, pct);
    els.soulCaption.textContent =
      total === 0 ? "An empty tome. Begin the ritual." :
      pct === 0 ? "The lantern is cold. Light it." :
      pct < 35 ? "A faint flicker stirs within." :
      pct < 70 ? "The flame grows hungry." :
      pct < 100 ? "Nearly ablaze. Finish them." :
      "Fully ablaze. You are free tonight.";
    if (lastPct >= 0 && pct > lastPct && total >= 4) {
      const hit = [[100, "THE END… or is it? Every task is slain."], [75, "Only stragglers remain. Finish them."], [50, "Halfway there. They're getting nervous."], [25, "A quarter of the horde has fallen."]]
        .find(([m]) => lastPct < m && pct >= m);
      if (hit) showToast(hit[1], false);
    }
    if (pct === 100 && total >= 3 && lastPct >= 0 && lastPct < 100) award("clean-slate");
    if (pct === 100 && lastPct >= 0 && lastPct < 100) {
      els.soulCard.classList.remove("blaze"); void els.soulCard.offsetWidth; els.soulCard.classList.add("blaze");
      const r = els.lantern.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, 28);
      for (let i = 0; i < 4; i++) setTimeout(() => ghost(r.left + r.width / 2 + (Math.random() - 0.5) * 80, r.top + r.height / 2), i * 160);
      batSwarm();
    }
    lastPct = pct;
  }

  function animateNumber(el, from, to) {
    if (reduceMotion || from === to) { el.textContent = to; return; }
    const start = performance.now(), dur = 700;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------------- effects ---------------- */
  function ghost(x, y) {
    if (reduceMotion) return;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    g.setAttribute("viewBox", "0 0 40 48");
    g.classList.add("fx-ghost");
    g.innerHTML = '<use href="#ghost"/>';
    g.style.left = x + "px"; g.style.top = y + "px";
    g.style.setProperty("--dx", (Math.random() * 60 - 30).toFixed(0) + "px");
    g.style.setProperty("--rot", (Math.random() * 24 - 12).toFixed(0) + "deg");
    els.fx.appendChild(g);
    g.addEventListener("animationend", () => g.remove());
  }

  function burst(x, y, n = 14) {
    if (reduceMotion) return;
    const colors = ["#d1141b", "#efe4cc", "#f0a500", "#d1141b", "#9fd34a"];
    for (let i = 0; i < n; i++) {
      const e = document.createElement("span");
      e.className = "fx-ember";
      const ang = Math.random() * Math.PI * 2, dist = 30 + Math.random() * 60;
      e.style.left = x + "px"; e.style.top = y + "px";
      e.style.setProperty("--x", Math.cos(ang) * dist + "px");
      e.style.setProperty("--y", Math.sin(ang) * dist - 20 + "px");
      e.style.setProperty("--c", colors[i % colors.length]);
      e.style.setProperty("--t", (0.6 + Math.random() * 0.6).toFixed(2) + "s");
      els.fx.appendChild(e);
      e.addEventListener("animationend", () => e.remove());
    }
  }

  /* ---------------- ambient sound (WebAudio, no files) ---------------- */
  const audio = { ctx: null, master: null };
  function startAmbience() {
    if (!audio.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      // wind: filtered noise with slow LFO on the filter
      const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 500; bp.Q.value = 0.8;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 300;
      lfo.connect(lfoGain).connect(bp.frequency);
      const windGain = ctx.createGain(); windGain.gain.value = 0.18;
      noise.connect(bp).connect(windGain).connect(master);
      // low drone
      [55, 82.4].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.detune.value = i ? 6 : -4;
        const g = ctx.createGain(); g.gain.value = 0.05; o.connect(g).connect(master); o.start();
      });
      noise.start(); lfo.start();
      Object.assign(audio, { ctx, master });
    }
    audio.ctx.resume();
    audio.master.gain.setTargetAtTime(0.5, audio.ctx.currentTime, 1.2);
  }
  function stopAmbience() {
    if (audio.ctx) audio.master.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.4);
  }
  // A swarm of bats bursts across the screen (100% celebration).
  function batSwarm(n = 14) {
    if (reduceMotion) return;
    for (let i = 0; i < n; i++) {
      const b = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      b.setAttribute("viewBox", "0 0 64 32");
      b.classList.add("fx-bat");
      b.innerHTML = '<use href="#bat"/>';
      const size = 26 + Math.random() * 34;
      b.style.width = size + "px";
      b.style.left = (Math.random() * 30 - 15) + "vw";
      b.style.top = (40 + Math.random() * 50) + "vh";
      b.style.setProperty("--dx", (110 + Math.random() * 30) + "vw");
      b.style.setProperty("--dy", (-60 - Math.random() * 40) + "vh");
      b.style.animationDelay = (Math.random() * 0.6).toFixed(2) + "s";
      b.style.animationDuration = (1.6 + Math.random() * 1.2).toFixed(2) + "s";
      els.fx.appendChild(b);
      b.addEventListener("animationend", (e) => { if (e.target === b) b.remove(); });
      setTimeout(() => b.remove(), 4500); // backstop: animations pause in background tabs
    }
  }

  // Short synthesized sound effects (only when ambient sound is on).
  function sfx(kind) {
    if (!prefs.sound || !audio.ctx) return;
    const ctx = audio.ctx, t = ctx.currentTime;
    if (kind === "thud") { // rubber-stamp thump
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
      g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    } else if (kind === "whoosh") { // filtered noise sweep
      const len = ctx.sampleRate * 0.45, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = buf; f.type = "bandpass"; f.Q.value = 1.2;
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(3000, t + 0.4);
      g.gain.setValueAtTime(0.35, t);
      src.connect(f).connect(g).connect(ctx.destination); src.start(t);
    }
  }

  function chime() {
    if (!prefs.sound || !audio.ctx) return;
    const ctx = audio.ctx, t = ctx.currentTime;
    [659.25, 987.77, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.07 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 1.2);
      o.connect(g).connect(ctx.destination); o.start(t + i * 0.07); o.stop(t + i * 0.07 + 1.3);
    });
  }
  els.soundToggle.addEventListener("click", () => {
    prefs.sound = !prefs.sound; savePrefs();
    els.soundToggle.setAttribute("aria-pressed", String(prefs.sound));
    prefs.sound ? startAmbience() : stopAmbience();
  });

  /* ---------------- actions ---------------- */
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await ready; // don't let a task added mid-load be overwritten by the server's list
    const raw = els.input.value.trim();
    const q = window.parseQuick ? window.parseQuick(raw) : { title: raw };
    const title = q.title;
    if (!title) {
      els.composerCard.classList.remove("shake"); void els.composerCard.offsetWidth; els.composerCard.classList.add("shake");
      els.input.focus();
      return;
    }
    const minOrder = tasks.reduce((m, t) => Math.min(m, t.order), 0);
    const t = {
      id: uid(), title, done: false, createdAt: Date.now(), completedAt: null, order: minOrder - 1,
      priority: q.priority ?? new FormData(els.form).get("priority"), tag: q.tag ?? els.tag.value,
      due: q.due ?? els.due.value, repeat: q.repeat ?? $("#repeatInput").value,
    };
    showQuickPreview(null);
    tasks.push(t); persist("POST", "/tasks", t);
    remember(`Summon “${truncate(t.title, 30)}”`, [{ id: t.id, before: null }]);
    els.input.value = ""; els.due.value = ""; els.due.classList.add("is-empty");
    els.input.placeholder = "What must be done before midnight?";
    $("#repeatInput").value = "";
    if (els.search.value) els.search.value = "";
    if (prefs.filter === "done") setFilter("all"); else render();
    const node = els.list.querySelector(`[data-id="${t.id}"]`);
    if (node) {
      node.classList.add("just-added");
      node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      const r = node.getBoundingClientRect(); burst(r.left + 30, r.top + r.height / 2, 10);
    }
  });

  /* ---------------- undo (Ctrl/⌘+Z) ---------------- */
  // Each entry stores the state of the tasks it touched *before* the change; null = the task didn't exist.
  const history = [];
  const snap = (t) => (t ? structuredClone(t) : null);
  const redoStack = [];
  function remember(label, items, extra = {}) {
    redoStack.length = 0; // a fresh change makes the old redo path meaningless
    history.push({ label, items, ...extra });
    if (history.length > 50) history.shift();
  }
  const FIELDS = ["title", "notes", "subtasks", "repeat", "priority", "tag", "due", "done", "order"];
  const FIELD_DEFAULTS = { notes: "", subtasks: [], repeat: "", due: "" }; // older local tasks may lack these
  // Puts each task back into the given state (null = it shouldn't exist), syncing the server.
  function applyStates(items) {
    for (const { id, before } of items) {
      const i = tasks.findIndex((x) => x.id === id);
      if (!before) {
        if (i >= 0) { tasks.splice(i, 1); persist("DELETE", `/tasks/${id}`); }
      } else if (i < 0) {
        tasks.push(before); persist("POST", "/tasks", before);
      } else {
        tasks[i] = before;
        persist("PATCH", `/tasks/${id}`, Object.fromEntries(FIELDS.map((f) => [f, before[f] ?? FIELD_DEFAULTS[f]])));
      }
    }
  }
  // The current state of the same tasks — used to build the opposite (redo/undo) entry.
  const currentStates = (items) => items.map(({ id }) => ({ id, before: snap(tasks.find((x) => x.id === id)) }));

  function undo() {
    const entry = history.pop();
    if (!entry) { showToast("Nothing left to undo.", false); return; }
    if (entry.buried) {
      const back = entry.items.map((i) => i.before).filter((b) => !tasks.some((x) => x.id === b.id));
      if (back.length) { tasks.push(...back); persist("POST", "/graveyard/restore", { ids: back.map((b) => b.id) }); }
      // (re-burying isn't offered as a redo — use "Bury all" again)
    } else {
      redoStack.push({ label: entry.label, items: currentStates(entry.items) });
      applyStates(entry.items);
    }
    render();
    showToast(`↶ Undid: ${entry.label}`, false);
  }
  function redo() {
    const entry = redoStack.pop();
    if (!entry) { showToast("Nothing to redo.", false); return; }
    history.push({ label: entry.label, items: currentStates(entry.items) });
    applyStates(entry.items);
    render();
    showToast(`↷ Redid: ${entry.label}`, false);
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if (e.target.closest("input, textarea, [contenteditable='true']")) return; // let fields undo their own typing
    if (!$("#auth").hidden || !$("#acct").hidden || !sc.el.hidden || !pal.el.hidden) return;
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  });

  function toggle(id, node) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const before = snap(t);
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    persist("PATCH", `/tasks/${id}`, { done: t.done });
    if (t.done && t.repeat) spawnNext(t);
    else if (!t.done && t.spawnId) unspawn(t);
    remember(`${t.done ? "Slay" : "Revive"} “${truncate(t.title, 30)}”`, [{ id, before }, ...(t.done && t.spawnId ? [{ id: t.spawnId, before: null }] : [])]);
    if (t.done && node) {
      const c = $(".check", node).getBoundingClientRect();
      burst(c.left + c.width / 2, c.top + c.height / 2);
      ghost(c.left + c.width / 2, c.top);
      chime();
      onSlain(t);
      if (t.priority === "scream" && !reduceMotion) {
        const l = $("#lightning");
        l.classList.remove("strike"); void l.offsetWidth; l.classList.add("strike");
        document.body.classList.remove("quake"); void document.body.offsetWidth; document.body.classList.add("quake");
      }
      if (matchMedia("(pointer: coarse)").matches) navigator.vibrate?.(15);
      node.classList.add("is-done", "just-done");
      const stamp = document.createElement("span");
      stamp.className = "stamp"; stamp.textContent = "Slain!";
      setTimeout(() => sfx("thud"), 200); // lands with the stamp
      node.appendChild(stamp);
      // let the stamp land and the strike-through play before re-ordering
      setTimeout(render, reduceMotion ? 0 : 900);
      updateSoul(tasks.filter((x) => x.done).length, tasks.length);
    } else {
      render();
    }
  }

  /* ---------------- recurring tasks ---------------- */
  function nextDue(from, repeat) {
    const d = new Date(from + "T00:00");
    if (repeat === "daily") d.setDate(d.getDate() + 1);
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    return toISODate(d);
  }
  // Completing a recurring task raises its next occurrence right below it.
  function spawnNext(t) {
    const today = toISODate(new Date());
    let due = nextDue(t.due || today, t.repeat);
    for (let i = 0; due < today && i < 400; i++) due = nextDue(due, t.repeat); // skip missed occurrences
    const next = {
      id: uid(), title: t.title, notes: t.notes || "", repeat: t.repeat, priority: t.priority, tag: t.tag, due,
      subtasks: (t.subtasks ?? []).map((s) => ({ ...s, id: uid(), done: false })),
      done: false, createdAt: Date.now(), completedAt: null, order: t.order + 0.5,
    };
    tasks.push(next);
    t.spawnId = next.id;
    persist("POST", "/tasks", next);
    setTimeout(() => showToast(`↻ It rises again — next on ${new Date(due + "T00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}.`, false), 1000);
  }
  // Un-slaying takes back the spawned copy, as long as nobody touched it.
  function unspawn(t) {
    const i = tasks.findIndex((x) => x.id === t.spawnId && !x.done);
    if (i >= 0) { tasks.splice(i, 1); persist("DELETE", `/tasks/${t.spawnId}`); }
    delete t.spawnId;
  }

  let lastDeleted = null, toastTimer = null;
  function banish(id, node) {
    const idx = tasks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    lastDeleted = { task: tasks[idx] };
    remember(`Banish “${truncate(tasks[idx].title, 30)}”`, [{ id, before: snap(tasks[idx]) }]);
    sfx("whoosh");
    tasks.splice(idx, 1); persist("DELETE", `/tasks/${id}`);
    const finish = () => render();
    if (node && !reduceMotion) {
      node.classList.add("banishing");
      node.addEventListener("animationend", finish, { once: true });
    } else finish();
    showToast(`“${truncate(lastDeleted.task.title, 34)}” was banished.`, true);
  }

  function showToast(text, undo) {
    els.toastText.textContent = text;
    els.toastUndo.hidden = !undo;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 5000);
  }
  els.toastUndo.addEventListener("click", () => {
    if (lastDeleted) {
      const restored = lastDeleted.tasks ?? [lastDeleted.task];
      tasks.push(...restored);
      if (lastDeleted.buried) persist("POST", "/graveyard/restore", { ids: restored.map((t) => t.id) }); // dig them back up
      else if (restored.length === 1) persist("POST", "/tasks", restored[0]);
      else persist("POST", "/tasks/bulk", restored);
      lastDeleted = null; render();
    }
    els.toast.classList.remove("show");
  });

  function buryDone() {
    const gone = tasks.filter((t) => t.done);
    if (!gone.length) return;
    lastDeleted = { tasks: gone, buried: true };
    remember(`Bury ${gone.length} task${gone.length === 1 ? "" : "s"}`, gone.map((t) => ({ id: t.id, before: snap(t) })), { buried: true });
    award("undertaker");
    $$(".task.is-done", els.list).forEach((n) => n.classList.add("banishing"));
    tasks = tasks.filter((t) => !t.done); persist("DELETE", "/tasks?done=true");
    setTimeout(render, reduceMotion ? 0 : 500);
    showToast(`${gone.length} vanquished ${gone.length === 1 ? "task" : "tasks"} laid to rest in the graveyard.`, true);
  }

  /* ---------------- trophies ---------------- */
  const STATS_KEY = "grimoire.trophies.v1";
  const TROPHIES = [
    { id: "first-blood", icon: "🩸", name: "First Blood", desc: "Slay your first task." },
    { id: "body-count", icon: "💀", name: "Body Count", desc: "Slay 10 tasks." },
    { id: "massacre", icon: "⚰️", name: "Massacre", desc: "Slay 25 tasks." },
    { id: "scream-queen", icon: "😱", name: "Scream Queen", desc: "Slay a Scream-level task." },
    { id: "night-owl", icon: "🦉", name: "Night Owl", desc: "Slay a task between midnight and 4 AM." },
    { id: "ahead", icon: "⏳", name: "Ahead of the Curse", desc: "Slay a task before its due day." },
    { id: "clean-slate", icon: "🕯️", name: "Clean Slate", desc: "Reach 100% with 3+ tasks." },
    { id: "undertaker", icon: "🪦", name: "Undertaker", desc: "Bury the vanquished." },
    { id: "hallows", icon: "🎃", name: "All Hallows", desc: "Slay a task on Halloween." },
    { id: "undying", icon: "🔥", name: "Undying", desc: "Slay tasks 3 nights in a row." },
    { id: "witching", icon: "⛧", name: "Witching Hour", desc: "Win a Witching Hour challenge." },
  ];
  const trophyState = { slain: 0, unlocked: {}, days: [], focusMin: 0, log: {}, ...(safeGet(STATS_KEY) ?? {}) };

  // Consecutive days (ending today, or yesterday if nothing slain yet today) with at least one slay.
  function streak() {
    const set = new Set(trophyState.days);
    const d = new Date();
    if (!set.has(toISODate(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (set.has(toISODate(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  const unlockQueue = [];

  // Merge server and local progress (take the best of both), then push the result back.
  async function syncTrophies() {
    try {
      const remote = await request("GET", "/trophies");
      trophyState.slain = Math.max(trophyState.slain, remote.slain || 0);
      trophyState.focusMin = Math.max(trophyState.focusMin || 0, remote.focusMin || 0);
      const log = { ...(remote.log || {}) };
      for (const [d, n] of Object.entries(trophyState.log || {})) log[d] = Math.max(log[d] || 0, n);
      trophyState.log = Object.fromEntries(Object.entries(log).sort().slice(-365));
      trophyState.unlocked = { ...remote.unlocked, ...trophyState.unlocked };
      trophyState.days = [...new Set([...(remote.days || []), ...trophyState.days])].sort().slice(-365);
      safeSet(STATS_KEY, trophyState);
      renderTrophies();
      saveTrophies();
    } catch { /* offline: local progress still works */ }
  }
  // Debounced: one slay can unlock several trophies at once, and parallel PUTs could land out of order.
  let trophySaveTimer = null;
  function saveTrophies() {
    safeSet(STATS_KEY, trophyState);
    clearTimeout(trophySaveTimer);
    trophySaveTimer = setTimeout(() => persist("PUT", "/trophies", trophyState), 250);
  }

  function award(id) {
    if (trophyState.unlocked[id]) return;
    trophyState.unlocked[id] = Date.now();
    saveTrophies();
    renderTrophies(id);
    unlockQueue.push(TROPHIES.find((t) => t.id === id));
    if (unlockQueue.length === 1) showUnlock();
  }
  function showUnlock() {
    const t = unlockQueue[0];
    if (!t) return;
    const el = $("#unlock");
    $("#unlockIcon").textContent = t.icon;
    $("#unlockName").textContent = t.name;
    $("#unlockDesc").textContent = t.desc;
    el.classList.add("show");
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => { unlockQueue.shift(); showUnlock(); }, 400);
    }, 3200);
  }
  function renderTrophies(fresh) {
    const grid = $("#trophyGrid");
    grid.replaceChildren(...TROPHIES.map((t) => {
      const li = document.createElement("li");
      const got = !!trophyState.unlocked[t.id];
      li.className = "trophy" + (got ? " got" : "") + (t.id === fresh ? " fresh" : "");
      li.tabIndex = 0;
      li.innerHTML = `<span class="trophy-icon">${got ? t.icon : "?"}</span><span class="trophy-tip"><b>${got ? t.name : "Locked"}</b>${t.desc}</span>`;
      li.setAttribute("aria-label", `${got ? t.name : "Locked trophy"}: ${t.desc}`);
      return li;
    }));
    $("#trophyCount").textContent = `${Object.keys(trophyState.unlocked).length}/${TROPHIES.length}`;
  }
  function onSlain(t) {
    trophyState.slain++;
    const now = new Date();
    const today = toISODate(now);
    if (!trophyState.days.includes(today)) trophyState.days = [...trophyState.days, today].slice(-365);
    trophyState.log = { ...(trophyState.log || {}), [today]: ((trophyState.log || {})[today] || 0) + 1 };
    saveTrophies();
    if (streak() >= 3) award("undying");
    challengeProgress();
    award("first-blood");
    if (trophyState.slain >= 10) award("body-count");
    if (trophyState.slain >= 25) award("massacre");
    if (t.priority === "scream") award("scream-queen");
    if (now.getHours() < 4) award("night-owl");
    if (t.due && t.due > toISODate(now)) award("ahead");
    if (now.getMonth() === 9 && now.getDate() === 31) award("hallows");
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  /* ---------------- inline editing ---------------- */
  function startEdit(node) {
    const titleEl = $(".task-title", node);
    if (titleEl.isContentEditable) return;
    const t = tasks.find((x) => x.id === node.dataset.id);
    node.draggable = false;
    titleEl.contentEditable = "true";
    titleEl.focus();
    const range = document.createRange(); range.selectNodeContents(titleEl);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);

    const finish = (commit) => {
      titleEl.removeEventListener("keydown", onKey);
      titleEl.removeEventListener("blur", onBlur);
      titleEl.contentEditable = "false";
      node.draggable = true;
      const val = titleEl.textContent.replace(/\s+/g, " ").trim();
      if (commit && val && t && val !== t.title) { remember(`Rename “${truncate(t.title, 30)}”`, [{ id: t.id, before: snap(t) }]); t.title = val.slice(0, 140); persist("PATCH", `/tasks/${t.id}`, { title: t.title }); }
      titleEl.textContent = t ? t.title : val;
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    titleEl.addEventListener("keydown", onKey);
    titleEl.addEventListener("blur", onBlur);
  }

  /* ---------------- first-run tour ---------------- */
  const TOUR = [
    { el: "#composer", title: "Summon tasks in plain words", text: "Try “Buy candy tomorrow !scream #errand every week” — dates, dread, realm and repeat are understood as you type." },
    { el: ".task .task-meta", title: "Click any tag to change it", text: "Dread, realm, date and repeat tags are buttons. Double-click a title to rename; swipe on phones to slay or banish." },
    { el: ".view-switch", title: "Three ways to see the horde", text: "List, Calendar (drag tasks between days) and Stats (your kill count and streaks)." },
    { el: "#paletteBtn", title: "Everything is one keystroke away", text: "Press ⌘K / Ctrl+K for every command and task. ⌘Z undoes your last move. Happy haunting!" },
  ];
  const tourKey = () => `grimoire.toured.${currentUser?.id || "local"}`;
  let tourIdx = 0;
  function startTour(force = false) {
    if (!force && safeGet(tourKey())) return;
    setView("list");
    tourIdx = 0;
    $("#tour").hidden = false;
    showTourStep();
    $("#tourNext").focus();
  }
  function showTourStep() {
    const step = TOUR[tourIdx];
    const target = $(step.el);
    if (!target) { return nextTourStep(); }
    target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    $("#tourStep").textContent = `Step ${tourIdx + 1} of ${TOUR.length}`;
    $("#tourTitle").textContent = step.title;
    $("#tourText").textContent = step.text;
    $("#tourNext").textContent = tourIdx === TOUR.length - 1 ? "Begin" : "Next";
    setTimeout(placeTour, reduceMotion ? 0 : 350); // after the scroll settles
  }
  function placeTour() {
    const target = $(TOUR[tourIdx].el);
    if (!target || $("#tour").hidden) return;
    const r = target.getBoundingClientRect(), pad = 8, spot = $("#tourSpot"), card = $("#tourCard");
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const cw = Math.min(340, innerWidth - 24);
    const below = r.bottom + 16 + 190 < innerHeight;
    card.style.width = `${cw}px`;
    card.style.left = `${Math.max(12, Math.min(innerWidth - cw - 12, r.left))}px`;
    card.style.top = below ? `${r.bottom + 16}px` : `${Math.max(12, r.top - 16 - card.offsetHeight)}px`;
  }
  function nextTourStep() {
    if (++tourIdx >= TOUR.length) return endTour();
    showTourStep();
  }
  function endTour() {
    $("#tour").hidden = true;
    safeSet(tourKey(), true);
    els.input.focus();
  }
  $("#tourNext").addEventListener("click", nextTourStep);
  $("#tourSkip").addEventListener("click", endTour);
  $("#tour").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); endTour(); } });
  // Keep the spotlight glued to its target while the page scrolls or resizes.
  let tourRaf = 0;
  const followTour = () => { if ($("#tour").hidden || tourRaf) return; tourRaf = requestAnimationFrame(() => { tourRaf = 0; placeTour(); }); };
  window.addEventListener("resize", followTour);
  window.addEventListener("scroll", followTour, { passive: true });

  /* ---------------- zen mode, favicon badge, fate ---------------- */
  function toggleZen(force) {
    const on = force ?? !document.body.classList.contains("zen");
    document.body.classList.toggle("zen", on);
    prefs.zen = on; savePrefs();
    showToast(on ? "Zen mode: only the tasks remain. Press Z to return." : "The spirits return.", false);
  }
  if (prefs.zen) document.body.classList.add("zen");

  // Draw the pumpkin favicon with a count badge of lurking tasks.
  const favicon = document.querySelector('link[rel="icon"]');
  let lastBadge = null;
  function updateFavicon(n) {
    if (n === lastBadge || !favicon) return;
    lastBadge = n;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    g.font = "52px serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("🎃", 30, 36);
    if (n > 0) {
      const label = n > 99 ? "99+" : String(n);
      g.fillStyle = "#d1141b"; g.strokeStyle = "#000"; g.lineWidth = 4;
      const w = Math.max(30, 14 + label.length * 14);
      g.fillRect(64 - w, 0, w, 30); g.strokeRect(64 - w + 2, 2, w - 4, 26);
      g.fillStyle = "#fff"; g.font = "bold 22px sans-serif"; g.fillText(label, 64 - w / 2, 16);
    }
    try { favicon.href = c.toDataURL("image/png"); } catch { /* canvas unavailable */ }
  }

  // Can't decide? Fate picks one, weighted towards dread and lateness.
  function summonFate() {
    const pool = tasks.filter((t) => !t.done);
    if (!pool.length) { showToast("Fate is silent — nothing lurks.", false); return; }
    const weight = (t) => 1 + PRIORITY[t.priority].rank * 2 + (isTonight(t) ? 3 : 0);
    let r = Math.random() * pool.reduce((s, t) => s + weight(t), 0);
    const pick = pool.find((t) => (r -= weight(t)) < 0) ?? pool[0];
    setView("list"); setFilter("all"); els.search.value = ""; render();
    focusTask(pick.id);
    els.list.querySelector(`[data-id="${pick.id}"]`)?.classList.add("just-added");
    showToast(`🔮 Fate has chosen: “${truncate(pick.title, 40)}”`, false);
  }

  /* ---------------- witching hour challenge ---------------- */
  // Slay CH_GOAL tasks within an hour. State lives in prefs so it survives reloads.
  const CH_GOAL = 3, CH_MS = 60 * 60 * 1000;
  let chTimer = null;
  function startChallenge() {
    const open = tasks.filter((t) => !t.done).length;
    if (open < CH_GOAL) { showToast(`You need at least ${CH_GOAL} lurking tasks to begin the Witching Hour.`, false); return; }
    prefs.challenge = { start: Date.now(), count: 0 }; savePrefs();
    showToast(`⛧ The Witching Hour begins: slay ${CH_GOAL} tasks before the clock strikes.`, false);
    tickChallenge();
  }
  function endChallenge(message) {
    prefs.challenge = null; savePrefs();
    clearInterval(chTimer); chTimer = null;
    $("#challengeChip").hidden = true;
    if (message) showToast(message, false);
  }
  function challengeProgress() {
    const ch = prefs.challenge;
    if (!ch || Date.now() - ch.start > CH_MS) return;
    ch.count++; savePrefs();
    if (ch.count >= CH_GOAL) {
      award("witching");
      batSwarm(20);
      const msg = `⛧ You survived the Witching Hour — ${CH_GOAL} slain in ${Math.ceil((Date.now() - ch.start) / 60000)} minutes!`;
      endChallenge();
      setTimeout(() => showToast(msg, false), 1300); // after any progress-milestone toast from the same slay
    } else tickChallenge();
  }
  function tickChallenge() {
    const ch = prefs.challenge, chip = $("#challengeChip");
    if (!ch) { chip.hidden = true; return; }
    const left = ch.start + CH_MS - Date.now();
    if (left <= 0) return endChallenge(`The Witching Hour has passed… ${ch.count}/${CH_GOAL} slain. Try again tomorrow night.`);
    chip.hidden = false;
    chip.textContent = `⛧ ${ch.count}/${CH_GOAL} · ${fmt(left)}`;
    if (!chTimer) chTimer = setInterval(tickChallenge, 1000);
  }
  $("#challengeChip").addEventListener("click", () => { if (confirm("Abandon the Witching Hour challenge?")) endChallenge("Challenge abandoned. The spirits are disappointed."); });

  /* ---------------- shortcuts sheet ---------------- */
  let keysOpener = null;
  function openKeys() { keysOpener = document.activeElement; $("#keysSheet").hidden = false; $("#keysClose").focus(); }
  function closeKeys() { $("#keysSheet").hidden = true; keysOpener?.focus?.(); }
  $("#keysClose").addEventListener("click", closeKeys);
  $("#keysSheet").addEventListener("mousedown", (e) => { if (e.target === e.currentTarget) closeKeys(); });
  $("#keysSheet").addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); closeKeys(); } });

  /* ---------------- duplicate ---------------- */
  function duplicateTask(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const copy = {
      ...structuredClone(t), id: uid(), title: `${t.title}`.slice(0, 140), done: false, completedAt: null, createdAt: Date.now(),
      focusMin: 0, order: t.order + 0.5, subtasks: (t.subtasks ?? []).map((s) => ({ ...s, id: uid(), done: false })),
    };
    delete copy.spawnId; delete copy.buriedAt;
    tasks.push(copy);
    persist("POST", "/tasks", copy);
    remember(`Duplicate “${truncate(t.title, 30)}”`, [{ id: copy.id, before: null }]);
    render();
    focusTask(copy.id);
    els.list.querySelector(`[data-id="${copy.id}"]`)?.classList.add("just-added");
    showToast("A doppelgänger appears.", false);
  }

  /* ---------------- snooze ---------------- */
  function snooze(ids) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const tomorrow = toISODate(d);
    const list = tasks.filter((t) => ids.includes(t.id) && !t.done);
    if (!list.length) return;
    remember(`Snooze ${list.length === 1 ? `“${truncate(list[0].title, 30)}”` : `${list.length} tasks`}`, list.map((t) => ({ id: t.id, before: snap(t) })));
    for (const t of list) { t.due = tomorrow; persist("PATCH", `/tasks/${t.id}`, { due: tomorrow }); }
    render();
    showToast(`💤 ${list.length === 1 ? "It sleeps" : `${list.length} tasks sleep`} until tomorrow.`, false);
  }

  /* ---------------- multi-select + bulk actions ---------------- */
  const selected = new Set();
  let lastPicked = null;
  function syncSelection() {
    for (const id of [...selected]) if (!tasks.some((t) => t.id === id)) selected.delete(id);
    $$(".task", els.list).forEach((n) => n.classList.toggle("selected", selected.has(n.dataset.id)));
    const bar = $("#bulkbar");
    bar.hidden = !selected.size;
    $("#bulkCount").textContent = `${selected.size} selected`;
  }
  function pickTask(id, range) {
    if (range && lastPicked) {
      const ids = $$(".task", els.list).map((n) => n.dataset.id);
      const [a, b] = [ids.indexOf(lastPicked), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) ids.slice(a, b + 1).forEach((x) => selected.add(x));
    } else {
      selected.has(id) ? selected.delete(id) : selected.add(id);
    }
    lastPicked = id;
    syncSelection();
  }
  function clearSelection() { selected.clear(); lastPicked = null; syncSelection(); }
  // Shift-click would otherwise highlight text across rows.
  els.list.addEventListener("mousedown", (e) => {
    if (e.shiftKey && e.target.closest(".task") && !e.target.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
  });
  $("#bulkbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (!b) return;
    const action = b.dataset.bulk;
    if (action === "clear") return clearSelection();
    const list = tasks.filter((t) => selected.has(t.id));
    if (!list.length) return clearSelection();
    if (action === "spell") { if (saveSpellFrom(list)) clearSelection(); return; }
    const plural = `${list.length} task${list.length === 1 ? "" : "s"}`;
    if (action === "banish") {
      remember(`Banish ${plural}`, list.map((t) => ({ id: t.id, before: snap(t) })));
      for (const t of list) { tasks.splice(tasks.indexOf(t), 1); persist("DELETE", `/tasks/${t.id}`); }
      lastDeleted = { tasks: list };
      showToast(`${plural} banished.`, true);
    } else {
      remember(`Bulk edit ${plural}`, list.map((t) => ({ id: t.id, before: snap(t) })));
      const d = new Date(); if (action === "tomorrow") d.setDate(d.getDate() + 1);
      for (const t of list) {
        const patch = action === "slay" ? { done: true }
          : PRIORITY[action] ? { priority: action }
          : { due: toISODate(d) };
        if (action === "slay" && t.done) continue;
        Object.assign(t, patch);
        if (action === "slay") { t.completedAt = Date.now(); onSlain(t); }
        persist("PATCH", `/tasks/${t.id}`, patch);
      }
      if (action === "slay") { const r = $("#bulkbar").getBoundingClientRect(); burst(r.left + r.width / 2, r.top, 24); chime(); }
      showToast(action === "slay" ? `${plural} slain in one stroke.` : `${plural} updated.`, false);
    }
    clearSelection();
    render();
  });

  els.list.addEventListener("click", (e) => {
    // ⌘/Ctrl-click toggles a task in the selection; Shift-click selects a range.
    const row = e.target.closest(".task");
    if (row && (e.metaKey || e.ctrlKey || e.shiftKey) && !e.target.closest("button, input, textarea, [contenteditable='true']")) {
      e.preventDefault();
      pickTask(row.dataset.id, e.shiftKey);
      return;
    }
    if (e.target.closest(".sh-toggle")) { prefs.hideDone = !prefs.hideDone; savePrefs(); render(); return; }
    if (e.target.closest(".bury")) { buryDone(); return; }
    if (e.target.closest(".grave-open")) { openGraveyard(); return; }
    if (e.target.closest(".snooze-all")) { snooze(tasks.filter(isTonight).map((t) => t.id)); return; }
    const node = e.target.closest(".task");
    if (!node) return;
    if (e.target.closest(".check")) toggle(node.dataset.id, node);
    else if (e.target.closest(".del")) banish(node.dataset.id, node);
    else if (e.target.closest(".edit")) startEdit(node);
    else if (e.target.closest(".note, .task-notes")) editNotes(node);
    else if (e.target.closest(".pill.steps, .steps-btn")) toggleSteps(node.dataset.id);
    else if (e.target.closest(".seance-btn")) openSeance(node.dataset.id);
    else if (e.target.closest(".sub-del")) removeStep(node.dataset.id, e.target.closest(".sub-del").dataset.sub);
    else if (e.target.closest(".pill.prio")) cycle(node, "priority", Object.keys(PRIORITY));
    else if (e.target.closest(".pill.tag")) cycle(node, "tag", Object.keys(TAGS));
    else if (e.target.closest(".pill.repeat")) cycle(node, "repeat", ["", ...Object.keys(REPEAT_LABEL)]);
    else if (e.target.closest(".pill.due")) pickDate(node, e.target.closest(".pill.due"));
    else if (e.target.closest(".pill.snooze")) snooze([node.dataset.id]);
  });

  // One shared native date input, positioned over the clicked pill so the picker opens in place.
  const picker = $("#duePicker");
  let pickingId = null;
  function pickDate(node, pill) {
    const t = tasks.find((x) => x.id === node.dataset.id);
    if (!t) return;
    pickingId = t.id;
    const r = pill.getBoundingClientRect();
    picker.style.left = r.left + "px";
    picker.style.top = r.bottom + "px";
    picker.value = t.due || "";
    try { picker.showPicker(); } catch { picker.focus(); }
  }
  picker.addEventListener("change", () => {
    const t = tasks.find((x) => x.id === pickingId);
    if (!t || picker.value === t.due) return;
    remember(`Change date of “${truncate(t.title, 30)}”`, [{ id: t.id, before: snap(t) }]);
    t.due = picker.value;
    persist("PATCH", `/tasks/${t.id}`, { due: t.due });
    render();
    els.list.querySelector(`[data-id="${t.id}"] .pill.due`)?.classList.add("bump");
  });

  // Clicking a pill rotates that field to its next value.
  function cycle(node, field, values) {
    const t = tasks.find((x) => x.id === node.dataset.id);
    if (!t) return;
    remember(`Change ${field === "tag" ? "realm" : field} of “${truncate(t.title, 30)}”`, [{ id: t.id, before: snap(t) }]);
    t[field] = values[(values.indexOf(t[field]) + 1) % values.length];
    persist("PATCH", `/tasks/${t.id}`, { [field]: t[field] });
    render();
    const fresh = els.list.querySelector(`[data-id="${t.id}"] .pill.${{ priority: "prio", tag: "tag", repeat: "repeat" }[field]}`);
    if (fresh) { fresh.classList.add("bump"); fresh.focus({ preventScroll: true }); }
  }
  els.list.addEventListener("dblclick", (e) => {
    const node = e.target.closest(".task");
    if (node && e.target.closest(".task-title")) startEdit(node);
  });

  /* ---------------- themes ---------------- */
  const THEMES = [
    { id: "", name: "Blood Moon" },
    { id: "witching", name: "Witching Hour" },
    { id: "pumpkin", name: "Pumpkin Patch" },
    { id: "bone", name: "Bone Paper" },
  ];
  function applyTheme(id, announce) {
    prefs.theme = id; savePrefs();
    if (id) document.documentElement.dataset.theme = id; else delete document.documentElement.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--sky-a").trim() || "#0c0b0a";
    if (announce) showToast(`Theme: ${THEMES.find((t) => t.id === id).name}`, false);
  }
  function nextTheme() {
    const i = THEMES.findIndex((t) => t.id === (prefs.theme || ""));
    applyTheme(THEMES[(i + 1) % THEMES.length].id, true);
  }
  $("#themeToggle").addEventListener("click", nextTheme);

  /* ---------------- spellbook: ready-made task bundles ---------------- */
  // `d` = days before Halloween the task is due.
  const SPELLS = [
    { id: "party", icon: "🎉", name: "Halloween Party", tasks: [
      { t: "Send party invites to the coven", p: "scream", g: "coven", d: 10 },
      { t: "Plan the spooky playlist", p: "whisper", g: "cauldron", d: 6 },
      { t: "Buy decorations: cobwebs, candles, skulls", p: "howl", g: "errand", d: 5 },
      { t: "Brew the punch (dry ice!)", p: "howl", g: "cauldron", d: 1 },
      { t: "Bake graveyard cupcakes", p: "howl", g: "cauldron", d: 1 },
      { t: "Decorate the lair", p: "scream", g: "crypt", d: 0 },
    ] },
    { id: "costume", icon: "🧛", name: "Costume Crafting", tasks: [
      { t: "Pick the costume", p: "scream", g: "cauldron", d: 12, s: ["Browse ideas", "Decide", "Make a materials list"] },
      { t: "Buy fabric, makeup and fake blood", p: "howl", g: "errand", d: 8 },
      { t: "Sew and assemble the costume", p: "howl", g: "crypt", d: 4 },
      { t: "Makeup test run", p: "whisper", g: "crypt", d: 2 },
      { t: "Final fitting", p: "howl", g: "crypt", d: 1 },
    ] },
    { id: "house", icon: "🏚️", name: "Haunt the House", tasks: [
      { t: "Carve the jack-o'-lanterns", p: "howl", g: "crypt", d: 2 },
      { t: "Hang cobwebs across the porch", p: "whisper", g: "crypt", d: 3 },
      { t: "Set up fog machine & spooky lights", p: "howl", g: "crypt", d: 1 },
      { t: "Test the doorbell scream sound", p: "whisper", g: "crypt", d: 1 },
    ] },
    { id: "trick", icon: "🍬", name: "Trick-or-Treat Night", tasks: [
      { t: "Buy candy for trick-or-treaters", p: "scream", g: "errand", d: 3 },
      { t: "Plan the trick-or-treat route", p: "whisper", g: "coven", d: 2 },
      { t: "Charge the flashlights", p: "whisper", g: "crypt", d: 0 },
      { t: "Sort the candy haul", p: "whisper", g: "crypt", d: -1 },
    ] },
  ];
  let customSpells = [];
  function castSpell(id) {
    const custom = customSpells.find((x) => x.id === id);
    if (custom) return castCustom(custom);
    const spell = SPELLS.find((x) => x.id === id);
    if (!spell) return;
    const today = toISODate(new Date());
    const { target } = nextHalloween();
    const eve = new Date(target.getFullYear(), 9, 31);
    const minOrder = tasks.reduce((m, t) => Math.min(m, t.order), 0);
    const made = spell.tasks.map((x, i) => {
      const d = new Date(eve); d.setDate(d.getDate() - x.d);
      const due = toISODate(d) < today ? today : toISODate(d);
      return {
        id: uid(), title: x.t, notes: "", priority: x.p, tag: x.g, due, repeat: "",
        subtasks: (x.s ?? []).map((text) => ({ id: uid(), text, done: false })),
        done: false, createdAt: Date.now(), completedAt: null, order: minOrder - spell.tasks.length + i,
      };
    });
    tasks.push(...made);
    remember(`Cast ${spell.name}`, made.map((m) => ({ id: m.id, before: null })));
    persist("POST", "/tasks/bulk", made);
    if (prefs.filter === "done") setFilter("all"); else render();
    showToast(`${spell.icon} ${spell.name}: ${made.length} tasks summoned.`, false);
  }

  function castCustom(spell) {
    const minOrder = tasks.reduce((m, t) => Math.min(m, t.order), 0);
    const made = spell.tasks.map((x, i) => {
      let due = "";
      if (x.d !== null && x.d !== undefined) { const d = new Date(); d.setDate(d.getDate() + x.d); due = toISODate(d); }
      return {
        id: uid(), title: x.t, notes: "", priority: x.p, tag: x.g, due, repeat: "",
        subtasks: (x.s ?? []).map((text) => ({ id: uid(), text, done: false })),
        done: false, createdAt: Date.now(), completedAt: null, order: minOrder - spell.tasks.length + i,
      };
    });
    tasks.push(...made);
    persist("POST", "/tasks/bulk", made);
    remember(`Cast ${spell.name}`, made.map((m) => ({ id: m.id, before: null })));
    if (prefs.filter === "done") setFilter("all"); else render();
    showToast(`📖 ${spell.name}: ${made.length} tasks summoned.`, false);
  }
  function saveSpellFrom(list) {
    if (!sync.online) { showToast("Saving spells needs the server — you're offline.", false); return false; }
    if (customSpells.length >= 20) { showToast("Your spellbook is full (20 spells). Forget one first.", false); return false; }
    const name = (prompt(`Name this spell (${list.length} task${list.length === 1 ? "" : "s"}):`, "") || "").trim();
    if (!name) return false;
    const today = new Date(toISODate(new Date()) + "T00:00");
    const spell = {
      id: uid(), name: name.slice(0, 40),
      tasks: list.slice(0, 30).map((t) => ({
        t: t.title, p: t.priority, g: t.tag,
        d: t.due ? Math.max(-60, Math.min(365, Math.round((new Date(t.due + "T00:00") - today) / 86400000))) : null,
        s: (t.subtasks ?? []).map((x) => x.text),
      })),
    };
    customSpells = [...customSpells, spell];
    persist("PUT", "/spells", customSpells);
    showToast(`📖 “${spell.name}” added to your spellbook — cast it from ⌘K.`, false);
    return true;
  }
  function forgetSpell(id) {
    const sp = customSpells.find((x) => x.id === id);
    if (!sp || !confirm(`Forget the spell “${sp.name}”?`)) return;
    customSpells = customSpells.filter((x) => x.id !== id);
    persist("PUT", "/spells", customSpells);
    showToast(`“${sp.name}” forgotten.`, false);
  }

  /* ---------------- command palette (Ctrl/⌘+K) ---------------- */
  const pal = { el: $("#palette"), input: $("#paletteInput"), list: $("#paletteList"), items: [], idx: 0, opener: null };
  function paletteCommands() {
    const cmds = [
      { icon: "✚", label: "New task", hint: "N", run: () => els.input.focus() },
      ...(history.length ? [{ icon: "↶", label: `Undo: ${history[history.length - 1].label}`, hint: "⌘Z", run: () => undo() }] : []),
      ...(redoStack.length ? [{ icon: "↷", label: `Redo: ${redoStack[redoStack.length - 1].label}`, hint: "⇧⌘Z", run: () => redo() }] : []),
      { icon: "☰", label: "Go to list view", hint: "L", run: () => setView("list") },
      { icon: "▦", label: "Go to calendar view", hint: "C", run: () => setView("calendar") },
      { icon: "▮", label: "Go to stats", hint: "S", run: () => setView("stats") },
      { icon: "◉", label: "Show all tasks", hint: "1", run: () => { setView("list"); setFilter("all"); } },
      { icon: "◌", label: "Show lurking tasks", hint: "2", run: () => { setView("list"); setFilter("active"); } },
      { icon: "☾", label: "Show tonight's tasks (due today or overdue)", hint: "4", run: () => { setView("list"); setFilter("tonight"); } },
      { icon: "✓", label: "Show vanquished tasks", hint: "3", run: () => { setView("list"); setFilter("done"); } },
      ...THEMES.map((t) => ({ icon: "◐", label: `Theme: ${t.name}`, hint: prefs.theme === t.id || (!prefs.theme && !t.id) ? "current" : "", run: () => applyTheme(t.id, true) })),
      { icon: "♫", label: prefs.sound ? "Turn ambient sound off" : "Turn ambient sound on", run: () => els.soundToggle.click() },
      { icon: "🪦", label: "Visit the graveyard", run: () => openGraveyard() },
      { icon: "?", label: "Take the tour again", run: () => startTour(true) },
      { icon: "⌨", label: "Show keyboard shortcuts", hint: "?", run: () => openKeys() },
      { icon: "☯", label: document.body.classList.contains("zen") ? "Leave zen mode" : "Zen mode (hide everything but tasks)", hint: "Z", run: () => toggleZen() },
      { icon: "🔮", label: "Let fate pick a task for me", hint: "G", run: () => summonFate() },
      prefs.challenge ? { icon: "⛧", label: "Abandon the Witching Hour challenge", run: () => endChallenge("Challenge abandoned.") }
                      : { icon: "⛧", label: `Start a Witching Hour challenge (slay ${CH_GOAL} in 60 min)`, run: () => startChallenge() },
      ...SPELLS.map((sp) => ({ icon: sp.icon, label: `Spellbook: ${sp.name} (${sp.tasks.length} tasks)`, run: () => castSpell(sp.id) })),
      ...customSpells.map((sp) => ({ icon: "📖", label: `My spell: ${sp.name} (${sp.tasks.length} tasks)`, run: () => castSpell(sp.id) })),
      ...customSpells.map((sp) => ({ icon: "✕", label: `Forget spell: ${sp.name}`, run: () => forgetSpell(sp.id) })),
      { icon: "⎙", label: "Print the list as a poster", run: () => { setView("list"); setTimeout(() => window.print(), 50); } },
      { icon: "⬇", label: "Export a backup", run: () => $("#exportLink").click() },
      ...(currentUser ? [{ icon: "⎋", label: `Log out (${currentUser.username})`, run: () => logout() }] : []),
      { icon: "⬆", label: "Import a backup", run: () => $("#importFile").click() },
    ];
    if (tasks.some((t) => t.done)) cmds.push({ icon: "🪦", label: "Bury the vanquished", run: () => buryDone() });
    return cmds;
  }
  // Subsequence fuzzy match: every query char in order; tighter/earlier matches score higher.
  function fuzzy(q, text) {
    if (!q) return 1;
    const t = text.toLowerCase();
    let pos = -1, score = 0, prev = -2;
    for (const ch of q) {
      pos = t.indexOf(ch, pos + 1);
      if (pos < 0) return 0;
      score += pos === prev + 1 ? 3 : 1;
      if (pos === 0 || /[\s\-:(]/.test(t[pos - 1])) score += 2;
      prev = pos;
    }
    return score - t.length * 0.01;
  }
  function renderPalette() {
    const q = pal.input.value.trim().toLowerCase();
    const cmds = paletteCommands().map((c) => ({ ...c, kind: "cmd", score: fuzzy(q, c.label) })).filter((c) => c.score > 0);
    const found = q ? tasks.map((t) => ({ kind: "task", task: t, label: t.title, score: fuzzy(q, t.title) })).filter((x) => x.score > 0) : [];
    found.sort((a, b) => b.score - a.score || Number(a.task.done) - Number(b.task.done));
    // With a query, rank tasks and commands together by match quality; without one, list commands in order.
    pal.items = q ? [...found.slice(0, 6), ...cmds].sort((a, b) => b.score - a.score).slice(0, 12) : cmds;
    if (q && !found.length && !cmds.length) pal.items = [{ kind: "cmd", icon: "✚", label: `Summon “${pal.input.value.trim()}”`, run: () => { els.input.value = pal.input.value.trim(); els.form.requestSubmit(); } }];
    pal.idx = Math.min(pal.idx, Math.max(0, pal.items.length - 1));
    pal.list.replaceChildren(...pal.items.map((it, i) => {
      const li = document.createElement("li");
      li.className = "pal-item" + (i === pal.idx ? " active" : "") + (it.kind === "task" ? " is-task" : "");
      li.id = `pal-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === pal.idx));
      const icon = document.createElement("span"); icon.className = "pal-icon";
      const label = document.createElement("span"); label.className = "pal-label";
      const hint = document.createElement("span"); hint.className = "pal-hint";
      if (it.kind === "task") {
        icon.textContent = it.task.done ? "✓" : "•";
        icon.classList.add(`p-${it.task.priority}`);
        label.textContent = it.task.title;
        hint.textContent = it.task.done ? "vanquished" : (dueInfo(it.task.due)?.text || "task");
      } else {
        icon.textContent = it.icon; label.textContent = it.label; hint.textContent = it.hint || "";
      }
      li.append(icon, label, hint);
      li.addEventListener("click", () => { pal.idx = i; runPalette(); });
      li.addEventListener("mousemove", () => { if (pal.idx !== i) { pal.idx = i; highlightPalette(); } });
      return li;
    }));
    highlightPalette();
  }
  function highlightPalette() {
    $$(".pal-item", pal.list).forEach((li, i) => { li.classList.toggle("active", i === pal.idx); li.setAttribute("aria-selected", String(i === pal.idx)); });
    pal.input.setAttribute("aria-activedescendant", pal.items.length ? `pal-${pal.idx}` : "");
    $(`#pal-${pal.idx}`)?.scrollIntoView({ block: "nearest" });
  }
  function openPalette() {
    pal.opener = document.activeElement;
    pal.el.hidden = false;
    pal.input.value = ""; pal.idx = 0;
    renderPalette();
    pal.input.focus();
  }
  function closePalette(restore = true) {
    pal.el.hidden = true;
    if (restore) pal.opener?.focus?.();
  }
  function runPalette() {
    const it = pal.items[pal.idx];
    if (!it) return;
    closePalette(false);
    if (it.kind === "task") {
      setView("list");
      if (it.task.done && prefs.filter === "active") setFilter("all");
      if (it.task.done && prefs.hideDone) { prefs.hideDone = false; savePrefs(); }
      els.search.value = ""; render();
      focusTask(it.task.id);
      els.list.querySelector(`[data-id="${it.task.id}"]`)?.classList.add("just-added");
    } else it.run();
  }
  pal.input.addEventListener("input", () => { pal.idx = 0; renderPalette(); });
  pal.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); pal.idx = (pal.idx + 1) % Math.max(1, pal.items.length); highlightPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pal.idx = (pal.idx - 1 + pal.items.length) % Math.max(1, pal.items.length); highlightPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  pal.el.addEventListener("mousedown", (e) => { if (e.target === pal.el) closePalette(); });
  $("#paletteBtn").addEventListener("click", openPalette);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (!sc.el.hidden) return;
      pal.el.hidden ? openPalette() : closePalette();
    }
  });

  /* ---------------- graveyard (buried tasks) ---------------- */
  const gy = { el: $("#graveyard"), list: $("#graveList"), opener: null };
  async function openGraveyard() {
    gy.opener = document.activeElement;
    gy.el.hidden = false;
    $("#graveClose").focus();
    gy.list.innerHTML = `<li class="grave-msg">Digging…</li>`;
    if (!sync.online) { gy.list.innerHTML = `<li class="grave-msg">The graveyard lives on the server — reconnect to visit it.</li>`; $("#graveEmpty").hidden = true; return; }
    try { renderGraveyard(await request("GET", "/graveyard")); }
    catch { gy.list.innerHTML = `<li class="grave-msg">The gates are locked. Try again in a moment.</li>`; }
  }
  function renderGraveyard(rows) {
    $("#graveEmpty").hidden = !rows.length;
    $("#graveCount").textContent = rows.length ? `${rows.length} at rest` : "";
    if (!rows.length) { gy.list.innerHTML = `<li class="grave-msg">No one rests here yet. Bury your vanquished tasks to fill it.</li>`; return; }
    gy.list.replaceChildren(...rows.map((t) => {
      const li = document.createElement("li");
      li.className = "grave-row";
      const stone = document.createElement("span"); stone.className = "grave-stone"; stone.textContent = "✝";
      const body = document.createElement("span"); body.className = "grave-body";
      const name = document.createElement("b"); name.textContent = t.title;
      const when = document.createElement("small");
      when.textContent = `${PRIORITY[t.priority]?.label ?? ""} · ${TAGS[t.tag] ?? ""} · buried ${new Date(t.buriedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
      body.append(name, when);
      const btn = Object.assign(document.createElement("button"), { type: "button", className: "link-btn", textContent: "Raise" });
      btn.setAttribute("aria-label", `Restore ${t.title}`);
      btn.addEventListener("click", () => {
        const { buriedAt, ...task } = t;
        tasks.push(task);
        persist("POST", "/graveyard/restore", { ids: [t.id] });
        li.classList.add("raised");
        setTimeout(() => {
          li.remove();
          const left = gy.list.querySelectorAll(".grave-row").length;
          if (!left) renderGraveyard([]); else $("#graveCount").textContent = `${left} at rest`;
        }, 450);
        render();
        showToast(`“${truncate(t.title, 30)}” rises from the grave.`, false);
      });
      li.append(stone, body, btn);
      return li;
    }));
  }
  function closeGraveyard() { gy.el.hidden = true; gy.opener?.focus?.(); }
  $("#graveClose").addEventListener("click", closeGraveyard);
  gy.el.addEventListener("mousedown", (e) => { if (e.target === gy.el) closeGraveyard(); });
  gy.el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeGraveyard(); } });
  $("#graveEmpty").addEventListener("click", async () => {
    if (!confirm("Destroy everything in the graveyard forever? This cannot be undone.")) return;
    try { await request("DELETE", "/graveyard"); renderGraveyard([]); showToast("The graveyard has been salted. Nothing remains.", false); }
    catch (err) { showToast(`Couldn't empty the graveyard: ${err.message}`, false); }
  });
  $("#graveLink").addEventListener("click", openGraveyard);

  /* ---------------- séance (focus timer) ---------------- */
  const sc = {
    el: $("#seance"), task: $("#seanceTask"), time: $("#seanceTime"), wax: $("#wax"), flame: $("#flame"),
    kicker: $("#seanceKicker"), running: $("#seanceRunning"), doneBox: $("#seanceDone"), pause: $("#seancePause"), total: $("#seanceTotal"),
  };
  const seance = { id: null, minutes: 25, endAt: 0, left: 0, paused: false, timer: null, opener: null, credited: 0 };
  const fmt = (ms) => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

  function openSeance(id) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    seance.opener = document.activeElement;
    seance.id = id;
    sc.task.textContent = t.title;
    sc.el.hidden = false;
    document.body.classList.add("seance-on");
    startSeance(seance.minutes);
    sc.pause.focus();
  }
  function startSeance(min) {
    seance.minutes = min;
    seance.endAt = Date.now() + min * 60000;
    seance.left = min * 60000;
    seance.paused = false;
    seance.credited = 0;
    $$(".seance-presets button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.min) === min)));
    sc.kicker.textContent = "A séance is in session";
    sc.running.hidden = false; sc.doneBox.hidden = true;
    sc.pause.textContent = "Pause";
    sc.el.classList.remove("over", "paused");
    clearInterval(seance.timer);
    seance.timer = setInterval(tickSeance, 250);
    tickSeance();
    updateTotal();
  }
  function tickSeance() {
    if (!seance.paused) seance.left = Math.max(0, seance.endAt - Date.now());
    const total = seance.minutes * 60000;
    sc.time.textContent = fmt(seance.left);
    sc.wax.style.height = `${12 + 88 * (seance.left / total)}%`;
    // credit whole focused minutes as they pass
    const elapsedMin = Math.floor((total - seance.left) / 60000);
    if (elapsedMin > seance.credited) {
      const delta = elapsedMin - seance.credited;
      seance.credited = elapsedMin;
      trophyState.focusMin = (trophyState.focusMin || 0) + delta;
      saveTrophies(); updateTotal();
      const t = tasks.find((x) => x.id === seance.id);
      if (t) { t.focusMin = (t.focusMin || 0) + delta; persist("PATCH", `/tasks/${t.id}`, { focusMin: t.focusMin }); }
    }
    document.title = `⏳ ${fmt(seance.left)} · ${sc.task.textContent}`;
    if (seance.left === 0) finishSeance();
  }
  function finishSeance() {
    clearInterval(seance.timer);
    sc.el.classList.add("over");
    sc.kicker.textContent = "The spirits have spoken";
    sc.time.textContent = "Time's up";
    sc.running.hidden = true; sc.doneBox.hidden = false;
    $("#seanceSlay").hidden = !!tasks.find((x) => x.id === seance.id)?.done;
    (sc.doneBox.querySelector("button:not([hidden])"))?.focus();
    chime();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("Grimoire", { body: `Séance over: ${sc.task.textContent}` }); } catch { /* ignore */ }
    }
    document.title = "✨ Séance over · Grimoire";
  }
  function closeSeance() {
    clearInterval(seance.timer);
    sc.el.hidden = true;
    document.body.classList.remove("seance-on");
    render();
    seance.opener?.focus?.();
  }
  function updateTotal() {
    const m = trophyState.focusMin || 0;
    sc.total.textContent = m ? `Total time spent in séance: ${m >= 60 ? `${Math.floor(m / 60)}h ` : ""}${m % 60}m` : "";
  }
  sc.pause.addEventListener("click", () => {
    seance.paused = !seance.paused;
    if (!seance.paused) seance.endAt = Date.now() + seance.left;
    sc.pause.textContent = seance.paused ? "Resume" : "Pause";
    sc.el.classList.toggle("paused", seance.paused);
  });
  $("#seanceMore").addEventListener("click", () => {
    seance.minutes += 5; seance.endAt += 5 * 60000; seance.left += 5 * 60000; tickSeance();
  });
  $("#seanceEnd").addEventListener("click", closeSeance);
  $("#seanceClose").addEventListener("click", closeSeance);
  $("#seanceAgain").addEventListener("click", () => startSeance(seance.minutes));
  $("#seanceSlay").addEventListener("click", () => {
    const id = seance.id;
    closeSeance();
    const node = els.list.querySelector(`[data-id="${id}"]`);
    if (node && !tasks.find((x) => x.id === id)?.done) toggle(id, node);
  });
  $$(".seance-presets button").forEach((b) => b.addEventListener("click", () => startSeance(Number(b.dataset.min))));
  sc.el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSeance(); }
    if (e.key === "Tab") { // keep focus inside the dialog
      const f = $$("button:not([hidden])", sc.el).filter((b) => b.offsetParent);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });

  /* ---------------- subtasks (checklist) ---------------- */
  const openSteps = new Set();
  function renderSteps(node, t) {
    const subs = t.subtasks ?? [];
    const doneN = subs.filter((s) => s.done).length;
    const pill = $(".pill.steps", node);
    pill.hidden = !subs.length;
    pill.textContent = `☑ ${doneN}/${subs.length}`;
    pill.classList.toggle("all", subs.length > 0 && doneN === subs.length);
    $(".steps-btn", node).classList.toggle("has-notes", subs.length > 0);
    const box = $(".subtasks", node);
    if (!openSteps.has(t.id)) return;
    box.hidden = false;
    node.draggable = false;
    node.classList.add("steps-open");
    const ul = document.createElement("ul");
    for (const s of subs) {
      const li = document.createElement("li");
      li.className = "sub" + (s.done ? " done" : "");
      const label = document.createElement("label");
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: s.done });
      cb.dataset.sub = s.id;
      const span = document.createElement("span");
      span.textContent = s.text;
      label.append(cb, span);
      const del = Object.assign(document.createElement("button"), { type: "button", className: "sub-del", textContent: "×" });
      del.dataset.sub = s.id;
      del.setAttribute("aria-label", `Remove step: ${s.text}`);
      li.append(label, del);
      ul.append(li);
    }
    const add = Object.assign(document.createElement("input"), {
      type: "text", className: "sub-add", maxLength: 120, placeholder: subs.length ? "Add another step… (Enter)" : "Break it into steps… (Enter to add)",
    });
    add.setAttribute("aria-label", "Add a step");
    box.replaceChildren(ul, add);
  }
  function toggleSteps(id) {
    openSteps.has(id) ? openSteps.delete(id) : openSteps.add(id);
    render();
    if (openSteps.has(id)) els.list.querySelector(`[data-id="${id}"] .sub-add`)?.focus();
  }
  function saveSteps(t) { persist("PATCH", `/tasks/${t.id}`, { subtasks: t.subtasks }); }
  function removeStep(taskId, subId) {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    remember("Remove a step", [{ id: t.id, before: snap(t) }]);
    t.subtasks = (t.subtasks ?? []).filter((s) => s.id !== subId);
    saveSteps(t); render();
    els.list.querySelector(`[data-id="${taskId}"] .sub-add`)?.focus();
  }
  els.list.addEventListener("change", (e) => {
    const cb = e.target.closest(".sub input[type=checkbox]");
    if (!cb) return;
    const node = cb.closest(".task");
    const t = tasks.find((x) => x.id === node.dataset.id);
    const s = t?.subtasks?.find((x) => x.id === cb.dataset.sub);
    if (!s) return;
    remember(`${cb.checked ? "Tick" : "Untick"} a step`, [{ id: t.id, before: snap(t) }]);
    s.done = cb.checked;
    saveSteps(t);
    if (s.done) {
      const r = cb.getBoundingClientRect();
      burst(r.left + r.width / 2, r.top + r.height / 2, 6);
      if (t.subtasks.every((x) => x.done) && !t.done) showToast("Every step is done — slay the whole task!", false);
    }
    render();
  });
  els.list.addEventListener("keydown", (e) => {
    const add = e.target.closest(".sub-add");
    if (!add) return;
    if (e.key === "Escape") { e.preventDefault(); toggleSteps(add.closest(".task").dataset.id); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = add.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    const id = add.closest(".task").dataset.id;
    const t = tasks.find((x) => x.id === id);
    if ((t.subtasks ?? []).length >= 30) { showToast("Thirty steps is the limit, even for a ritual.", false); return; }
    remember("Add a step", [{ id: t.id, before: snap(t) }]);
    t.subtasks = [...(t.subtasks ?? []), { id: uid(), text, done: false }];
    saveSteps(t); render();
    els.list.querySelector(`[data-id="${id}"] .sub-add`)?.focus();
  });

  /* ---------------- notes ---------------- */
  function editNotes(node) {
    if ($(".notes-edit", node)) return;
    const t = tasks.find((x) => x.id === node.dataset.id);
    if (!t) return;
    const view = $(".task-notes", node);
    const ta = document.createElement("textarea");
    ta.className = "notes-edit";
    ta.maxLength = 1000;
    ta.rows = 3;
    ta.placeholder = "Scrawl your notes… (⌘/Ctrl+Enter to save, Esc to cancel)";
    ta.value = t.notes || "";
    view.hidden = true;
    view.after(ta);
    node.draggable = false;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let done = false;
    const finish = (commit) => {
      if (done) return; done = true;
      const val = ta.value.trim();
      ta.remove();
      node.draggable = true;
      if (commit && val !== (t.notes || "")) {
        remember(`Edit notes of “${truncate(t.title, 30)}”`, [{ id: t.id, before: snap(t) }]);
        t.notes = val;
        persist("PATCH", `/tasks/${t.id}`, { notes: val });
      }
      render();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener("blur", () => finish(true));
  }

  /* ---------------- swipe (touch): right = slay, left = banish ---------------- */
  const SWIPE_AT = 90;
  let swipe = null;
  els.list.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    const node = e.target.closest(".task");
    if (!node || e.target.closest("button, textarea, input, label, [contenteditable='true']")) return;
    swipe = { node, id: node.dataset.id, x: e.clientX, y: e.clientY, dx: 0, active: false };
  });
  els.list.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    if (!swipe.active) {
      if (Math.abs(dy) > 12) { swipe = null; return; } // vertical scroll wins
      if (Math.abs(dx) < 12) return;
      swipe.active = true;
      swipe.node.classList.add("swiping");
    }
    swipe.dx = dx;
    swipe.node.style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)`;
    swipe.node.dataset.swipe = dx > SWIPE_AT ? "slay" : dx < -SWIPE_AT ? "banish" : "";
  });
  const endSwipe = () => {
    if (!swipe) return;
    const { node, id, dx, active } = swipe;
    swipe = null;
    if (!active) return;
    node.classList.remove("swiping");
    node.style.transform = "";
    delete node.dataset.swipe;
    if (dx > SWIPE_AT) toggle(id, node);
    else if (dx < -SWIPE_AT) banish(id, node);
  };
  els.list.addEventListener("pointerup", endSwipe);
  els.list.addEventListener("pointercancel", endSwipe);

  /* ---------------- drag to reorder ---------------- */
  let dragId = null;
  els.list.addEventListener("dragstart", (e) => {
    const node = e.target.closest(".task");
    if (!node || els.list.classList.contains("no-drag")) { e.preventDefault(); return; }
    dragId = node.dataset.id;
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
  });
  els.list.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const node = e.target.closest(".task");
    $$(".drop-before, .drop-after", els.list).forEach((n) => n.classList.remove("drop-before", "drop-after"));
    if (!node || node.dataset.id === dragId) return;
    const r = node.getBoundingClientRect();
    node.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
  });
  els.list.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = $(".drop-before, .drop-after", els.list);
    if (!target || !dragId) return;
    const ids = visibleTasks().map((t) => t.id).filter((id) => id !== dragId);
    let at = ids.indexOf(target.dataset.id);
    if (target.classList.contains("drop-after")) at += 1;
    ids.splice(at, 0, dragId);
    // re-number only the visible tasks, preserving their existing order slots
    const slots = ids.map((id) => tasks.find((t) => t.id === id).order).sort((a, b) => a - b);
    ids.forEach((id, i) => { tasks.find((t) => t.id === id).order = slots[i]; });
    // normalise to 0..n so client and server agree on the exact order values
    tasks.sort((a, b) => a.order - b.order).forEach((t, i) => (t.order = i));
    persist("PUT", "/tasks/reorder", { ids: tasks.map((t) => t.id) });
    render();
  });
  els.list.addEventListener("dragend", () => {
    dragId = null;
    $$(".dragging, .drop-before, .drop-after", els.list).forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
  });

  /* ---------------- filters / sort / search ---------------- */
  function positionGlider() {
    const active = els.tabs.find((t) => t.dataset.filter === prefs.filter);
    if (!active) return;
    els.glider.style.width = active.offsetWidth + "px";
    els.glider.style.transform = `translateX(${active.offsetLeft}px)`;
  }
  function setFilter(f) {
    prefs.filter = f; savePrefs();
    els.tabs.forEach((t) => {
      const on = t.dataset.filter === f;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    positionGlider();
    render();
  }
  els.tabs.forEach((t) => t.addEventListener("click", () => setFilter(t.dataset.filter)));
  els.sort.addEventListener("change", () => { prefs.sort = els.sort.value; savePrefs(); render(); });
  els.search.addEventListener("input", render);

  // Live preview of what quick-add understood from the typed title.
  function showQuickPreview(q) {
    const box = $("#quickPreview");
    const chips = [];
    if (q?.due) chips.push(`<span class="qp due">📅 ${dueInfo(q.due).text}</span>`);
    if (q?.priority) chips.push(`<span class="qp p-${q.priority}">${PRIORITY[q.priority].label}</span>`);
    if (q?.tag) chips.push(`<span class="qp">${TAGS[q.tag]}</span>`);
    if (q?.repeat) chips.push(`<span class="qp rep">↻ ${REPEAT_LABEL[q.repeat]}</span>`);
    box.hidden = !chips.length;
    box.innerHTML = chips.length ? `<span class="qp-label">Understood:</span>${chips.join("")}` : "";
  }
  els.input.addEventListener("input", () => showQuickPreview(window.parseQuick?.(els.input.value.trim())));

  // Pasting several lines summons one task per line (each line gets quick-add parsing).
  els.input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") || "";
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, "").trim()).filter(Boolean);
    if (lines.length < 2) return; // single line: normal paste
    e.preventDefault();
    if (lines.length > 100) { showToast("That's more than 100 lines — paste a shorter list.", false); return; }
    if (!confirm(`Summon ${lines.length} tasks, one per line?`)) return;
    const minOrder = tasks.reduce((m, t) => Math.min(m, t.order), 0);
    const made = lines.map((line, i) => {
      const q = window.parseQuick ? window.parseQuick(line) : { title: line };
      return {
        id: uid(), title: q.title.slice(0, 140), notes: "", subtasks: [], done: false, createdAt: Date.now(), completedAt: null,
        order: minOrder - lines.length + i,
        priority: q.priority ?? new FormData(els.form).get("priority"), tag: q.tag ?? els.tag.value,
        due: q.due ?? els.due.value, repeat: q.repeat ?? $("#repeatInput").value,
      };
    });
    tasks.push(...made);
    persist("POST", "/tasks/bulk", made);
    remember(`Paste ${made.length} tasks`, made.map((m) => ({ id: m.id, before: null })));
    if (prefs.filter === "done") setFilter("all"); else render();
    showToast(`📜 ${made.length} tasks summoned from your list.`, false);
  });
  els.due.addEventListener("input", () => els.due.classList.toggle("is-empty", !els.due.value));
  if ("ResizeObserver" in window) new ResizeObserver(positionGlider).observe(els.glider.parentElement);
  else window.addEventListener("resize", positionGlider);

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", (e) => {
    if (!sc.el.hidden || !pal.el.hidden || !gy.el.hidden || !$("#auth").hidden || !$("#acct").hidden || !$("#tour").hidden || !$("#keysSheet").hidden) return;
    const typing = e.target.closest("input, textarea, select, [contenteditable='true']");
    if (e.key === "Escape" && e.target === els.search) { els.search.value = ""; els.search.blur(); render(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") { els.toast.classList.remove("show"); $("#unlock").classList.remove("show"); if (selected.size) clearSelection(); return; }
    if (e.key === "n" || e.key === "N") { e.preventDefault(); els.input.focus(); }
    else if (e.key === "/") { e.preventDefault(); els.search.focus(); }
    else if (e.key === "1") setFilter("all");
    else if (e.key === "2") setFilter("active");
    else if (e.key === "3") setFilter("done");
    else if (e.key === "4") setFilter("tonight");
    else if (e.key === "l" || e.key === "L") setView("list");
    else if (e.key === "c" || e.key === "C") setView("calendar");
    else if (e.key === "t" || e.key === "T") nextTheme();
    else if (e.key === "s" || e.key === "S") setView("stats");
    else if (e.key === "?") { e.preventDefault(); openKeys(); }
    else if (e.key === "z" || e.key === "Z") toggleZen();
    else if (e.key === "g" || e.key === "G") summonFate();
    else handleTaskKeys(e);
  });

  // Vim-style list navigation. Only acts when the task row itself (not a button inside it) has focus.
  function focusTask(id) {
    const n = id && els.list.querySelector(`.task[data-id="${id}"]`);
    if (n) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: "nearest" }); }
  }
  // Shift+J/K: swap a task with its neighbour (same section) in manual order.
  function moveTask(id, dir) {
    if (els.list.classList.contains("no-drag")) { showToast("Switch to “Ritual order” and clear search to reorder.", false); return; }
    const t = tasks.find((x) => x.id === id);
    const peers = visibleTasks().filter((x) => x.done === t.done);
    const i = peers.indexOf(t), j = i + dir;
    if (j < 0 || j >= peers.length) return;
    [t.order, peers[j].order] = [peers[j].order, t.order];
    tasks.sort((a, b) => a.order - b.order).forEach((x, n) => (x.order = n));
    persist("PUT", "/tasks/reorder", { ids: tasks.map((x) => x.id) });
    render();
    focusTask(id);
  }

  function handleTaskKeys(e) {
    const items = $$(".task", els.list);
    const cur = document.activeElement?.closest?.(".task");
    const onRow = cur && document.activeElement === cur;
    const k = e.key.toLowerCase();
    if (onRow && e.shiftKey && (k === "j" || k === "k")) {
      e.preventDefault();
      moveTask(cur.dataset.id, k === "j" ? 1 : -1);
      return;
    }
    if (k === "j" || k === "k" || (cur && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      if (!items.length) return;
      e.preventDefault();
      const dir = k === "j" || e.key === "ArrowDown" ? 1 : -1;
      const i = items.indexOf(cur);
      const next = i < 0 ? items[dir > 0 ? 0 : items.length - 1] : items[Math.max(0, Math.min(items.length - 1, i + dir))];
      focusTask(next.dataset.id);
      return;
    }
    if (!onRow) return;
    const id = cur.dataset.id;
    if (k === "x" || e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle(id, cur);
      setTimeout(() => focusTask(id), reduceMotion ? 20 : 950);
    } else if (k === "e") {
      e.preventDefault(); startEdit(cur);
    } else if (k === "r") {
      e.preventDefault(); cycle(cur, "repeat", ["", ...Object.keys(REPEAT_LABEL)]); focusTask(id);
      const t = tasks.find((x) => x.id === id);
      showToast(t.repeat ? `↻ Repeats ${REPEAT_LABEL[t.repeat].toLowerCase()}.` : "No longer repeats.", false);
    } else if (k === "d") {
      e.preventDefault(); duplicateTask(id);
    } else if (k === "f") {
      e.preventDefault(); openSeance(id);
    } else if (k === "p") {
      e.preventDefault(); cycle(cur, "priority", Object.keys(PRIORITY)); focusTask(id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const i = items.indexOf(cur);
      const neighbour = (items[i + 1] || items[i - 1])?.dataset.id;
      banish(id, cur);
      setTimeout(() => focusTask(neighbour), reduceMotion ? 20 : 650);
    }
  }

  /* ---------------- countdown ---------------- */
  const cdEls = Object.fromEntries($$(".cd-num").map((el) => [el.dataset.unit, el]));
  const eyebrow = $(".hero .eyebrow");
  // Before Oct 31: count down to it. On Oct 31: count down to midnight (the night itself). After: next year.
  const EYEBROW_DEFAULT = eyebrow.textContent;
  function nextHalloween(now = new Date()) {
    const y = now.getFullYear();
    const start = new Date(y, 9, 31), end = new Date(y, 10, 1);
    if (now < start) return { target: start, live: false };
    if (now < end) return { target: end, live: true };
    return { target: new Date(y + 1, 9, 31), live: false };
  }
  function tickCountdown() {
    const now = new Date(), { target, live } = nextHalloween(now);
    const diff = Math.max(0, target - now);
    eyebrow.textContent = live ? "🎃 Tonight's the night — until midnight" : EYEBROW_DEFAULT;
    const parts = {
      d: Math.floor(diff / 86400000),
      h: Math.floor((diff / 3600000) % 24),
      m: Math.floor((diff / 60000) % 60),
      s: Math.floor((diff / 1000) % 60),
    };
    for (const [k, v] of Object.entries(parts)) {
      const s = String(v).padStart(2, "0");
      const el = cdEls[k];
      if (el.textContent !== s) {
        el.textContent = s;
        if (!reduceMotion) { el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick"); }
      }
    }
  }

  /* ---------------- starfield ---------------- */
  function stars() {
    const canvas = $("#stars");
    const ctx = canvas.getContext("2d");
    let w, h, dpr, pts = [];
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round((w * h) / 5200);
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h * 0.75,
        r: Math.random() < 0.08 ? 1.3 + Math.random() * 0.6 : 0.4 + Math.random() * 0.8,
        a: 0.25 + Math.random() * 0.6, sp: 0.4 + Math.random() * 1.6, ph: Math.random() * Math.PI * 2,
        hue: Math.random() < 0.15 ? "255,210,170" : Math.random() < 0.2 ? "210,190,255" : "255,250,240",
      }));
    };
    const draw = (t) => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        const tw = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(t / 1000 * p.sp + p.ph);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${p.hue},${(p.a * tw).toFixed(3)})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        if (p.r > 1.2) {
          ctx.fillStyle = `rgba(${p.hue},${(0.08 * tw).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (!reduceMotion) requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener("resize", resize);
    requestAnimationFrame(draw);
  }

  /* ---------------- candlelight cursor ---------------- */
  function candlelight() {
    if (reduceMotion || window.matchMedia("(hover: none)").matches) return;
    const el = $("#candlelight");
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y, running = false;
    const loop = () => {
      x += (tx - x) * 0.12; y += (ty - y) * 0.12;
      el.style.transform = `translate(${x - 350}px, ${y - 350}px)`;
      if (Math.abs(tx - x) + Math.abs(ty - y) > 0.5) requestAnimationFrame(loop); else running = false;
    };
    window.addEventListener("pointermove", (e) => {
      tx = e.clientX; ty = e.clientY; el.style.opacity = "1";
      if (!running) { running = true; requestAnimationFrame(loop); }
    });
    document.addEventListener("pointerleave", () => (el.style.opacity = "0"));
  }

  /* ---------------- init ---------------- */
  els.sort.value = prefs.sort;
  $$(".view-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === (prefs.view || "list"))));
  els.soundToggle.setAttribute("aria-pressed", "false");
  prefs.sound = false; // browsers require a click before audio can start
  setSync();
  // ?view=calendar|stats (used by the installed app's shortcuts)
  const viewParam = new URLSearchParams(location.search).get("view");
  if (["list", "calendar", "stats"].includes(viewParam)) prefs.view = viewParam;

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker not registered:", err.message));
  }

  renderTrophies();
  const ready = load().then(() => {
    setFilter(prefs.filter);
    tickChallenge(); // resume a challenge that was running before a reload
    setRemindLabel();
    setTimeout(remindIfDue, 1500);
    if (tasks.length) setTimeout(() => startTour(), 900);
    const overdue = tasks.filter((t) => !t.done && dueInfo(t.due)?.cls === "late").length;
    if (overdue) setTimeout(() => showToast(`${overdue} ${overdue === 1 ? "task has" : "tasks have"} risen from the grave — ${overdue === 1 ? "it's" : "they're"} overdue.`, false), 900);
  });
  tickCountdown(); setInterval(tickCountdown, 1000);
  stars();
  candlelight();
  document.fonts?.ready.then(positionGlider);
})();
