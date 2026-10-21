// Grimoire server: static frontend + JSON REST API. Zero dependencies.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { openDb, PRIORITIES, TAGS, REPEATS } from "./db.js";
import { toIcs } from "./ics.js";
import { hashPassword, verifyPassword, readCookie, sessionCookie, clearCookie, rateLimiter, USERNAME_RE } from "./auth.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT) || 5317;
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const db = openDb(process.env.DB_FILE || join(ROOT, "data", "grimoire.db"));

const PRODUCTION = process.env.NODE_ENV === "production";
const SECURE_COOKIES = process.env.SECURE_COOKIES === "1"; // force Secure cookies (serving over HTTPS)
const TRUST_PROXY = process.env.TRUST_PROXY === "1";       // behind a reverse proxy / PaaS load balancer
// Only adopt pre-accounts data on local installs — never hand it to a stranger on a public site.
const CLAIM_LEGACY = !PRODUCTION && process.env.CLAIM_LEGACY !== "0";

const isSecure = (req) => SECURE_COOKIES || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
const clientIp = (req) => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
const loginLimiter = rateLimiter(Number(process.env.AUTH_RATE_LIMIT) || 10, 60_000); // auth attempts / minute / IP
const writeLimiter = rateLimiter(Number(process.env.WRITE_RATE_LIMIT) || 300, 60_000); // API writes / minute / user

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/* ---------------- helpers ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, "Payload too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates a task payload. `partial` allows missing fields (PATCH).
function validate(body, partial = false) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Expected an object");
  const out = {};
  if ("title" in body || !partial) {
    const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
    if (!title) throw new HttpError(400, "Title is required");
    out.title = title.slice(0, 140);
  }
  if ("notes" in body) {
    if (typeof body.notes !== "string") throw new HttpError(400, "Invalid notes");
    out.notes = body.notes.trim().slice(0, 1000);
  }
  if ("repeat" in body) {
    if (!REPEATS.includes(body.repeat)) throw new HttpError(400, "Invalid repeat");
    out.repeat = body.repeat;
  }
  if ("subtasks" in body) {
    const subs = body.subtasks;
    if (!Array.isArray(subs) || subs.length > 30) throw new HttpError(400, "Subtasks must be an array (max 30)");
    out.subtasks = subs.map((s) => {
      if (typeof s?.text !== "string" || typeof s.id !== "string" || !/^[\w-]{1,64}$/.test(s.id)) throw new HttpError(400, "Invalid subtask");
      const text = s.text.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) throw new HttpError(400, "Subtask text is required");
      return { id: s.id, text, done: !!s.done };
    });
  }
  if ("priority" in body) {
    if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, "Invalid priority");
    out.priority = body.priority;
  }
  if ("tag" in body) {
    if (!TAGS.includes(body.tag)) throw new HttpError(400, "Invalid tag");
    out.tag = body.tag;
  }
  if ("due" in body) {
    if (body.due !== "" && !(typeof body.due === "string" && DATE_RE.test(body.due))) throw new HttpError(400, "Invalid due date");
    out.due = body.due;
  }
  if ("done" in body) out.done = !!body.done;
  if ("focusMin" in body) {
    if (!Number.isInteger(body.focusMin) || body.focusMin < 0 || body.focusMin > 1_000_000) throw new HttpError(400, "Invalid focus minutes");
    out.focusMin = body.focusMin;
  }
  if ("order" in body) {
    if (!Number.isFinite(body.order)) throw new HttpError(400, "Invalid order");
    out.order = body.order;
  }
  // Client-supplied id/timestamps are accepted on create so "undo" can restore a task exactly.
  if (!partial) {
    if ("id" in body) {
      if (typeof body.id !== "string" || !/^[\w-]{1,64}$/.test(body.id)) throw new HttpError(400, "Invalid id");
      out.id = body.id;
    }
    if (Number.isFinite(body.createdAt)) out.createdAt = body.createdAt;
    if (Number.isFinite(body.completedAt)) out.completedAt = body.completedAt;
  }
  return out;
}

// Trophy progress: { slain: number, unlocked: { [trophyId]: timestamp } }
function validateTrophies(body) {
  const slain = body?.slain;
  if (!Number.isInteger(slain) || slain < 0) throw new HttpError(400, "Invalid slain count");
  const unlocked = body.unlocked ?? {};
  if (typeof unlocked !== "object" || Array.isArray(unlocked)) throw new HttpError(400, "Invalid unlocked map");
  const entries = Object.entries(unlocked);
  if (entries.length > 50 || !entries.every(([k, v]) => /^[a-z-]{1,32}$/.test(k) && Number.isFinite(v))) {
    throw new HttpError(400, "Invalid unlocked map");
  }
  const days = body.days ?? [];
  if (!Array.isArray(days) || days.length > 400 || !days.every((d) => typeof d === "string" && DATE_RE.test(d))) {
    throw new HttpError(400, "Invalid days list");
  }
  const focusMin = body.focusMin ?? 0;
  if (!Number.isInteger(focusMin) || focusMin < 0) throw new HttpError(400, "Invalid focus minutes");
  const log = body.log ?? {};
  if (typeof log !== "object" || Array.isArray(log)) throw new HttpError(400, "Invalid log");
  const logEntries = Object.entries(log);
  if (logEntries.length > 400 || !logEntries.every(([d, n]) => DATE_RE.test(d) && Number.isInteger(n) && n >= 0 && n <= 10000)) {
    throw new HttpError(400, "Invalid log");
  }
  return { slain, unlocked: Object.fromEntries(entries), days, focusMin, log: Object.fromEntries(logEntries) };
}

/* ---------------- auth ---------------- */
async function authRoutes(req, res, action) {
  const method = req.method;
  // Like /me but never 401s — for public pages that just want to know "signed in or not?"
  if (action === "session" && method === "GET") return send(res, 200, { user: db.sessionUser(readCookie(req)) });
  if (action === "me" && method === "GET") {
    const user = db.sessionUser(readCookie(req));
    if (!user) throw new HttpError(401, "Not logged in");
    return send(res, 200, { user });
  }
  if (action === "logout-all" && method === "POST") {
    const user = db.sessionUser(readCookie(req));
    if (!user) throw new HttpError(401, "Not logged in");
    const ended = db.endAllSessions(user.id);
    res.setHeader("Set-Cookie", clearCookie(isSecure(req)));
    return send(res, 200, { ended });
  }
  if (action === "logout" && method === "POST") {
    db.deleteSession(readCookie(req));
    res.setHeader("Set-Cookie", clearCookie(isSecure(req)));
    return send(res, 200, { ok: true });
  }
  // ---- account settings (require a live session) ----
  if (["password", "feed-token", "share", "account"].includes(action)) {
    const user = db.sessionUser(readCookie(req));
    if (!user) throw new HttpError(401, "Not logged in");
    if (action === "feed-token" && method === "POST") return send(res, 200, { user: db.rotateFeedToken(user.id) });
    if (action === "share" && method === "POST") {
      const { enabled } = await readJson(req);
      return send(res, 200, { user: db.setSharing(user.id, !!enabled) });
    }
    if (!loginLimiter(clientIp(req))) throw new HttpError(429, "Too many attempts — wait a minute and try again");
    const body = await readJson(req);
    const current = typeof body.password === "string" ? body.password : "";
    if (!(await verifyPassword(current, db.passHashFor(user.id)))) throw new HttpError(403, "That password isn't right");
    if (action === "password" && method === "POST") {
      const next = typeof body.newPassword === "string" ? body.newPassword : "";
      if (next.length < 8 || next.length > 200) throw new HttpError(400, "New password must be at least 8 characters");
      db.setPassword(user.id, await hashPassword(next));
      const { token, maxAge } = db.createSession(user.id); // keep this device signed in
      res.setHeader("Set-Cookie", sessionCookie(token, maxAge, isSecure(req)));
      return send(res, 200, { ok: true });
    }
    if (action === "account" && method === "DELETE") {
      db.deleteUser(user.id);
      res.setHeader("Set-Cookie", clearCookie(isSecure(req)));
      return send(res, 200, { deleted: true });
    }
    throw new HttpError(405, "Method not allowed");
  }
  if ((action === "register" || action === "login") && method === "POST") {
    if (!loginLimiter(clientIp(req))) throw new HttpError(429, "Too many attempts — wait a minute and try again");
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!USERNAME_RE.test(username)) throw new HttpError(400, "Username must be 3–24 letters, numbers, _ or -");
    if (password.length < 8 || password.length > 200) throw new HttpError(400, "Password must be at least 8 characters");

    let user, status = 200, claimed = 0;
    if (action === "register") {
      if (db.findUser(username)) throw new HttpError(409, "That name is already taken");
      ({ user, claimed } = db.createUser(username, await hashPassword(password), { claimLegacy: CLAIM_LEGACY }));
      if (db.forUser(user.id).isEmpty()) seed(db.forUser(user.id));
      status = 201;
    } else {
      const row = db.findUser(username);
      // Same message for unknown user and wrong password, so names can't be probed.
      if (!row || !(await verifyPassword(password, row.pass_hash))) throw new HttpError(401, "Wrong name or password");
      user = db.userById(row.id);
    }
    const { token, maxAge } = db.createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookie(token, maxAge, isSecure(req)));
    return send(res, status, { user, claimed });
  }
  throw new HttpError(404, "Not found");
}

// Custom spells: [{ id, name, tasks: [{ t, p, g, d|null, s[] }] }] — d = days after casting.
function validateSpells(body) {
  if (!Array.isArray(body) || body.length > 20) throw new HttpError(400, "Expected up to 20 spells");
  return body.map((sp) => {
    const name = typeof sp?.name === "string" ? sp.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!name || typeof sp.id !== "string" || !/^[\w-]{1,64}$/.test(sp.id)) throw new HttpError(400, "Invalid spell");
    if (!Array.isArray(sp.tasks) || !sp.tasks.length || sp.tasks.length > 30) throw new HttpError(400, "A spell needs 1–30 tasks");
    const tasks = sp.tasks.map((x) => {
      const t = typeof x?.t === "string" ? x.t.replace(/\s+/g, " ").trim().slice(0, 140) : "";
      if (!t || !PRIORITIES.includes(x.p) || !TAGS.includes(x.g)) throw new HttpError(400, "Invalid spell task");
      if (!(x.d === null || x.d === undefined || (Number.isInteger(x.d) && x.d >= -60 && x.d <= 365))) throw new HttpError(400, "Invalid day offset");
      const steps = Array.isArray(x.s) ? x.s.filter((v) => typeof v === "string" && v.trim()).slice(0, 30).map((v) => v.trim().slice(0, 120)) : [];
      return { t, p: x.p, g: x.g, d: x.d ?? null, s: steps };
    });
    return { id: sp.id, name, tasks };
  });
}

/* ---------------- API ---------------- */
async function api(req, res, path) {
  const method = req.method;
  const [, , resource, id] = path.split("/"); // "", "api", "tasks", ":id"

  if (resource === "health" && method === "GET") return send(res, 200, { ok: true });

  // CSRF: state-changing requests must come from our own origin and carry JSON
  // (cross-site forms can only send form/text bodies; the cookie is also SameSite=Lax).
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-origin request blocked");
    const len = Number(req.headers["content-length"] || 0);
    if (len > 0 && !String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Send JSON");
  }

  if (resource === "auth") return authRoutes(req, res, id);

  // Public read-only share page data (token from the owner's share link).
  if (resource === "share" && method === "GET") {
    const data = /^[a-f0-9]{36}$/.test(id || "") ? db.sharedList(id) : null;
    if (!data) throw new HttpError(404, "This poster has been taken down");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return send(res, 200, data);
  }

  // Calendar apps can't log in, so the feed is authorised by the user's private feed token.
  if (resource === "calendar.ics" && method === "GET") {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    const owner = token && db.userByFeedToken(token);
    if (!owner) throw new HttpError(401, "Missing or invalid feed token");
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="grimoire.ics"', "Cache-Control": "no-store" });
    res.end(toIcs(db.forUser(owner.id).list()));
    return;
  }

  const user = db.sessionUser(readCookie(req));
  if (!user) throw new HttpError(401, "Not logged in");
  const store = db.forUser(user.id);
  if (!["GET", "HEAD"].includes(method) && !writeLimiter(user.id)) throw new HttpError(429, "Slow down — too many changes in a minute");
  if (resource === "export" && method === "GET") {
    const stamp = new Date().toLocaleDateString("en-CA");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="grimoire-backup-${stamp}.json"`,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ app: "grimoire", version: 1, exportedAt: new Date().toISOString(), tasks: store.list(), graveyard: store.graveyard(), trophies: store.getMeta("trophies") }, null, 2));
    return;
  }
  if (resource === "import") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);
    if (body?.app !== "grimoire" || !Array.isArray(body.tasks) || body.tasks.length > 2000) throw new HttpError(400, "Not a Grimoire backup");
    const inputs = body.tasks.map((t) => validate(t)); // validate everything before touching the DB
    const ids = inputs.map((i) => i.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "Backup contains duplicate ids");
    // ids are global keys: ones owned by another account get fresh ids instead of clashing
    const mine = new Set([...store.list(), ...store.graveyard()].map((t) => t.id));
    for (const i of inputs) if (i.id && !mine.has(i.id) && store.exists(i.id)) delete i.id;
    const trophies = body.trophies ? validateTrophies(body.trophies) : null;
    const tasks = store.replaceAll(inputs);
    if (trophies) store.setMeta("trophies", trophies);
    return send(res, 200, { imported: tasks.length });
  }
  if (resource === "graveyard") {
    if (!id && method === "GET") return send(res, 200, store.graveyard());
    if (!id && method === "DELETE") return send(res, 200, { destroyed: store.emptyGraveyard() });
    if (id === "restore" && method === "POST") {
      const { ids } = await readJson(req);
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string") || ids.length > 2000) throw new HttpError(400, "Expected { ids: string[] }");
      return send(res, 200, { restored: store.restore(ids) });
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (resource === "spells") {
    if (method === "GET") return send(res, 200, store.getMeta("spells") ?? []);
    if (method === "PUT") return send(res, 200, store.setMeta("spells", validateSpells(await readJson(req))));
    throw new HttpError(405, "Method not allowed");
  }
  if (resource === "trophies") {
    if (method === "GET") return send(res, 200, { slain: 0, unlocked: {}, days: [], focusMin: 0, log: {}, ...store.getMeta("trophies") });
    if (method === "PUT") return send(res, 200, store.setMeta("trophies", validateTrophies(await readJson(req))));
    throw new HttpError(405, "Method not allowed");
  }
  if (resource !== "tasks") throw new HttpError(404, "Not found");

  if (!id) {
    if (method === "GET") return send(res, 200, store.list());
    if (method === "POST") {
      const input = validate(await readJson(req));
      if (input.id && store.exists(input.id)) throw new HttpError(409, "Task already exists");
      return send(res, 201, store.create(input));
    }
    if (method === "DELETE") {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("done") !== "true") throw new HttpError(400, "Use ?done=true to clear completed tasks");
      return send(res, 200, { removed: store.buryDone() }); // buried in the graveyard, not destroyed
    }
    throw new HttpError(405, "Method not allowed");
  }

  if (id === "bulk") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readJson(req);
    if (!Array.isArray(body) || body.length === 0 || body.length > 500) throw new HttpError(400, "Expected a non-empty array (max 500)");
    const inputs = body.map((b) => validate(b));
    const ids = inputs.map((i) => i.id).filter(Boolean);
    if (new Set(ids).size !== ids.length || ids.some((x) => store.exists(x))) throw new HttpError(409, "Duplicate or existing task id");
    return send(res, 201, store.createMany(inputs));
  }

  if (id === "reorder") {
    if (method !== "PUT") throw new HttpError(405, "Method not allowed");
    const { ids } = await readJson(req);
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "Expected { ids: string[] }");
    store.reorder(ids);
    return send(res, 200, store.list());
  }

  if (method === "GET") {
    const t = store.get(id);
    if (!t) throw new HttpError(404, "Task not found");
    return send(res, 200, t);
  }
  if (method === "PATCH") {
    const t = store.update(id, validate(await readJson(req), true));
    if (!t) throw new HttpError(404, "Task not found");
    return send(res, 200, t);
  }
  if (method === "DELETE") {
    if (!store.remove(id)) throw new HttpError(404, "Task not found");
    res.writeHead(204).end();
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

/* ---------------- static ---------------- */
async function serveStatic(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const page = PAGES[path.replace(/\/+$/, "") || "/"];
  const rel = normalize(decodeURIComponent(page || path));
  let file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) throw new HttpError(403, "Forbidden");
  let info, status = 200;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error();
  } catch {
    // Pages get the themed 404; missing assets get a plain one.
    if (extname(rel) && extname(rel) !== ".html") throw new HttpError(404, "Not found");
    file = join(PUBLIC, "404.html"); status = 404;
    info = await stat(file);
  }
  // Revalidate every time (so edits show on refresh) but answer 304 when nothing changed.
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (status === 200 && req.headers["if-none-match"] === etag) { res.writeHead(304, headers).end(); return; }

  let body = await readFile(file);
  if (COMPRESSIBLE.has(extname(file)) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && body.length > 1024) {
    const key = `${file}|${etag}`;
    let gz = gzipCache.get(key);
    if (!gz) { gz = gzipSync(body); gzipCache.set(key, gz); if (gzipCache.size > 100) gzipCache.delete(gzipCache.keys().next().value); }
    body = gz;
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
// Clean URLs for the site's pages.
const PAGES = { "/": "/index.html", "/app": "/app.html", "/login": "/auth.html", "/signup": "/auth.html", "/privacy": "/privacy.html" };
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg", ".json", ".webmanifest"]);
const gzipCache = new Map();

/* ---------------- server ---------------- */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (isSecure(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  const path = new URL(req.url, "http://x").pathname;
  const started = performance.now();
  try {
    if (path.startsWith("/api/")) await api(req, res, path);
    else await serveStatic(req, res, path);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) {
      if (path.startsWith("/api/")) send(res, status, { error: err.message || "Server error" });
      else res.writeHead(status, { "Content-Type": "text/plain" }).end(status === 404 ? "Not found" : "Error");
    }
  } finally {
    if (path.startsWith("/api/")) console.log(`${req.method} ${path} ${res.statusCode} ${(performance.now() - started).toFixed(1)}ms`);
  }
});

// Close the database cleanly on Ctrl+C / kill so WAL data is checkpointed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => console.log(`🎃 Grimoire running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));

function seed(store) {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); }; // local YYYY-MM-DD
  [
    { title: "Carve the jack-o'-lantern for the porch", priority: "howl", tag: "crypt", due: day(2) },
    { title: "Finish the costume — stitch the cape hem", priority: "scream", tag: "cauldron", due: day(1) },
    { title: "Buy 3 bags of candy (and hide one from myself)", priority: "whisper", tag: "errand", due: day(4) },
    { title: "Send invites for the midnight séance", priority: "howl", tag: "coven", due: day(3) },
    { title: "Submit the quarterly report before it haunts me", priority: "scream", tag: "ledger", due: day(-1) },
    { title: "Hang cobwebs across the hallway", priority: "whisper", tag: "crypt", due: "", done: true },
  ].forEach((t, i) => store.create({ ...t, order: i }));
}
