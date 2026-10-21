// API tests: boots a real server against a throwaway database.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 5399;
const BASE = `http://127.0.0.1:${PORT}/api`;
const dir = mkdtempSync(join(tmpdir(), "grimoire-test-"));
let server;
let cookie = "";   // session of the main test user
let feedToken = "";

// JSON request helper. Sends the main user's session cookie unless `as` overrides it.
const req = async (method, path, body, as = cookie) => {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as) headers.Cookie = as;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
};
const authedFetch = (path) => fetch(BASE + path, { headers: { Cookie: cookie } });
const sessionFrom = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

async function register(username, password = "correct horse battery") {
  const res = await req("POST", "/auth/register", { username, password }, "");
  return { ...res, cookie: sessionFrom(res) };
}

before(async () => {
  server = spawn(process.execPath, ["server/server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: join(dir, "test.db"), AUTH_RATE_LIMIT: "1000", WRITE_RATE_LIMIT: "5000" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await register("tester");
  if (r.status !== 201) throw new Error("could not register test user: " + JSON.stringify(r.body));
  cookie = r.cookie;
  feedToken = r.body.user.feedToken;
});

after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("a new account starts with sample tasks", async () => {
  const { status, body } = await req("GET", "/tasks");
  assert.equal(status, 200);
  assert.equal(body.length, 6);
});

test("creates a task with trimmed title and defaults", async () => {
  const { status, body } = await req("POST", "/tasks", { title: "  Buy   fangs  " });
  assert.equal(status, 201);
  assert.equal(body.title, "Buy fangs");
  assert.equal(body.priority, "whisper");
  assert.equal(body.tag, "crypt");
  assert.equal(body.done, false);
});

test("rejects invalid input", async () => {
  assert.equal((await req("POST", "/tasks", { title: "   " })).status, 400);
  assert.equal((await req("POST", "/tasks", { title: "x", priority: "boo" })).status, 400);
  assert.equal((await req("POST", "/tasks", { title: "x", due: "31/10/2026" })).status, 400);
  assert.equal((await req("POST", "/tasks", "{oops")).status, 400);
});

test("patch toggles done and stamps completedAt", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "Patch me" });
  const { body: done } = await req("PATCH", `/tasks/${t.id}`, { done: true, priority: "scream" });
  assert.equal(done.done, true);
  assert.equal(done.priority, "scream");
  assert.ok(done.completedAt > 0);
  const { body: undone } = await req("PATCH", `/tasks/${t.id}`, { done: false });
  assert.equal(undone.completedAt, null);
  assert.equal((await req("PATCH", "/tasks/nope", { done: true })).status, 404);
});

test("restoring with a client id works once, then conflicts", async () => {
  const task = { id: "restore-me-1", title: "Undo target", createdAt: 1000 };
  assert.equal((await req("POST", "/tasks", task)).status, 201);
  assert.equal((await req("POST", "/tasks", task)).status, 409);
});

test("reorder persists the given order", async () => {
  const { body: all } = await req("GET", "/tasks");
  const ids = all.map((t) => t.id).reverse();
  const { body: after } = await req("PUT", "/tasks/reorder", { ids });
  assert.deepEqual(after.map((t) => t.id), ids);
});

test("delete removes one task; ?done=true clears completed", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "Doomed" });
  assert.equal((await req("DELETE", `/tasks/${t.id}`)).status, 204);
  assert.equal((await req("DELETE", `/tasks/${t.id}`)).status, 404);

  const { body: cleared } = await req("DELETE", "/tasks?done=true");
  assert.ok(cleared.removed >= 1);
  const { body: rest } = await req("GET", "/tasks");
  assert.ok(rest.every((x) => !x.done));
});

test("static server blocks path traversal", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/..%2fserver%2fdb.js`);
  assert.notEqual(res.status, 200);
});

test("trophies round-trip and reject bad shapes", async () => {
  assert.deepEqual((await req("GET", "/trophies")).body, { slain: 0, unlocked: {}, days: [], focusMin: 0, log: {} });
  const saved = await req("PUT", "/trophies", { slain: 3, unlocked: { "first-blood": 123 }, days: ["2026-10-20"], focusMin: 50, log: { "2026-10-20": 3 } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await req("GET", "/trophies")).body, { slain: 3, unlocked: { "first-blood": 123 }, days: ["2026-10-20"], focusMin: 50, log: { "2026-10-20": 3 } });
  assert.equal((await req("PUT", "/trophies", { slain: 1, log: { "2026-10-20": -1 } })).status, 400);
  assert.equal((await req("PUT", "/trophies", { slain: 1, focusMin: 1.5 })).status, 400);
  assert.equal((await req("PUT", "/trophies", { slain: 1, days: ["yesterday"] })).status, 400);
  assert.equal((await req("PUT", "/trophies", { slain: -1 })).status, 400);
  assert.equal((await req("PUT", "/trophies", { slain: 1, unlocked: { "<script>": 1 } })).status, 400);
});

test("bulk restore is all-or-nothing", async () => {
  const ok = await req("POST", "/tasks/bulk", [{ id: "bulk-a", title: "A" }, { id: "bulk-b", title: "B", done: true }]);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.length, 2);
  // one bad item rejects the whole batch
  const bad = await req("POST", "/tasks/bulk", [{ id: "bulk-c", title: "C" }, { title: "" }]);
  assert.equal(bad.status, 400);
  assert.equal((await req("GET", "/tasks/bulk-c")).status, 404);
  assert.equal((await req("POST", "/tasks/bulk", [{ id: "bulk-a", title: "dupe" }])).status, 409);
});

test("notes are stored, trimmed and validated", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "With notes", notes: "  bring garlic  " });
  assert.equal(t.notes, "bring garlic");
  const { body: p } = await req("PATCH", `/tasks/${t.id}`, { notes: "x".repeat(2000) });
  assert.equal(p.notes.length, 1000);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { notes: 42 })).status, 400);
});

test("export returns a downloadable backup", async () => {
  const res = await authedFetch("/export");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="grimoire-backup-\d{4}-\d{2}-\d{2}\.json"/);
  const data = await res.json();
  assert.equal(data.app, "grimoire");
  assert.ok(Array.isArray(data.tasks) && data.tasks.length > 0);
});

test("import replaces tasks atomically and rejects bad backups", async () => {
  assert.equal((await req("POST", "/import", { app: "other", tasks: [] })).status, 400);
  // a bad task anywhere aborts the whole import, leaving data untouched
  const before = (await req("GET", "/tasks")).body.length;
  assert.equal((await req("POST", "/import", { app: "grimoire", tasks: [{ title: "ok" }, { title: "" }] })).status, 400);
  assert.equal((await req("GET", "/tasks")).body.length, before);

  const backup = await (await authedFetch("/export")).json();
  await req("POST", "/tasks", { title: "added after backup" });
  const { status, body } = await req("POST", "/import", backup);
  assert.equal(status, 200);
  assert.equal(body.imported, backup.tasks.length);
  assert.deepEqual((await req("GET", "/tasks")).body.map((t) => t.id), backup.tasks.map((t) => t.id));
});

test("subtasks round-trip and are validated", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "Steps", subtasks: [{ id: "s1", text: "  buy   wax ", done: false }] });
  assert.deepEqual(t.subtasks, [{ id: "s1", text: "buy wax", done: false }]);
  const { body: p } = await req("PATCH", `/tasks/${t.id}`, { subtasks: [{ id: "s1", text: "buy wax", done: true }, { id: "s2", text: "melt" }] });
  assert.deepEqual(p.subtasks.map((s) => s.done), [true, false]);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { subtasks: [{ id: "s3", text: "" }] })).status, 400);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { subtasks: "nope" })).status, 400);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { subtasks: Array.from({ length: 31 }, (_, i) => ({ id: "x" + i, text: "t" })) })).status, 400);
});

test("repeat is stored and validated", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "Water the mandrakes", repeat: "weekly" });
  assert.equal(t.repeat, "weekly");
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { repeat: "hourly" })).status, 400);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { repeat: "" })).body.repeat, "");
  assert.equal((await req("POST", "/tasks", { title: "plain" })).body.repeat, "");
});

test("calendar feed lists unfinished dated tasks as all-day events", async () => {
  await req("POST", "/tasks", { title: "Séance, with; commas\\and slashes", due: "2026-10-31", repeat: "weekly", priority: "scream", notes: "line one\nline two" });
  await req("POST", "/tasks", { title: "No date" });
  assert.equal((await fetch(BASE + "/calendar.ics")).status, 401);
  assert.equal((await fetch(BASE + "/calendar.ics?token=nope")).status, 401);
  const res = await fetch(BASE + "/calendar.ics?token=" + feedToken);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/calendar/);
  const ics = await res.text();
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /SUMMARY:Séance\\, with\; commas\\\\and slashes/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101/);
  assert.match(unfolded, /RRULE:FREQ=WEEKLY/);
  assert.match(unfolded, /DESCRIPTION:line one\\nline two/);
  assert.doesNotMatch(unfolded, /SUMMARY:No date/);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test("burying moves completed tasks to the graveyard, where they can be restored or destroyed", async () => {
  const { body: a } = await req("POST", "/tasks", { title: "Rest in peace", done: true });
  const { body: b } = await req("POST", "/tasks", { title: "Also resting", done: true });
  await req("DELETE", "/tasks?done=true");
  const live = (await req("GET", "/tasks")).body.map((t) => t.id);
  assert.ok(!live.includes(a.id) && !live.includes(b.id));
  const grave = (await req("GET", "/graveyard")).body;
  assert.ok(grave.some((t) => t.id === a.id && t.buriedAt > 0));

  assert.equal((await req("POST", "/graveyard/restore", { ids: [a.id] })).body.restored, 1);
  assert.ok((await req("GET", "/tasks")).body.some((t) => t.id === a.id));
  assert.equal((await req("POST", "/graveyard/restore", { ids: "nope" })).status, 400);

  const { body: emptied } = await req("DELETE", "/graveyard");
  assert.ok(emptied.destroyed >= 1);
  assert.equal((await req("GET", "/tasks/" + b.id)).status, 404);
  assert.deepEqual((await req("GET", "/graveyard")).body, []);
});

test("auth: register, login, me, logout", async () => {
  assert.equal((await register("tester")).status, 409);                       // name taken
  assert.equal((await register("x")).status, 400);                            // name too short
  assert.equal((await register("shorty", "1234")).status, 400);               // weak password
  assert.equal((await req("POST", "/auth/login", { username: "tester", password: "wrong password" }, "")).status, 401);
  assert.equal((await req("POST", "/auth/login", { username: "nobody", password: "whatever123" }, "")).status, 401);

  const login = await req("POST", "/auth/login", { username: "TESTER", password: "correct horse battery" }, "");
  assert.equal(login.status, 200);
  const c = sessionFrom(login);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal((await req("GET", "/auth/me", undefined, c)).body.user.username, "tester");

  await req("POST", "/auth/logout", undefined, c);
  assert.equal((await req("GET", "/auth/me", undefined, c)).status, 401);     // session revoked
  assert.equal((await req("GET", "/tasks", undefined, "")).status, 401);      // no cookie, no tasks
});

test("auth: each account only sees its own tasks", async () => {
  const other = await register("rival");
  const { body: secret } = await req("POST", "/tasks", { title: "my secret ritual" });
  const theirs = (await req("GET", "/tasks", undefined, other.cookie)).body;
  assert.ok(!theirs.some((t) => t.id === secret.id));
  assert.equal((await req("GET", `/tasks/${secret.id}`, undefined, other.cookie)).status, 404);
  assert.equal((await req("PATCH", `/tasks/${secret.id}`, { title: "hijacked" }, other.cookie)).status, 404);
  assert.equal((await req("DELETE", `/tasks/${secret.id}`, undefined, other.cookie)).status, 404);
  assert.equal((await req("POST", "/tasks", { id: secret.id, title: "clash" }, other.cookie)).status, 409);
  assert.equal((await req("GET", `/tasks/${secret.id}`)).body.title, "my secret ritual");
});

test("csrf: cross-origin and non-JSON writes are refused", async () => {
  const cross = await fetch(BASE + "/tasks", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie },
    body: JSON.stringify({ title: "pwned" }),
  });
  assert.equal(cross.status, 403);
  const form = await fetch(BASE + "/tasks", {
    method: "POST", headers: { "Content-Type": "text/plain", Cookie: cookie }, body: JSON.stringify({ title: "pwned" }),
  });
  assert.equal(form.status, 415);
});

test("account: change password, rotate feed token, delete account", async () => {
  const pw = "first password 1";
  const { cookie: c, body: reg } = await register("lich", pw);
  const other = sessionFrom(await req("POST", "/auth/login", { username: "lich", password: pw }, ""));

  assert.equal((await req("POST", "/auth/password", { password: "nope nope", newPassword: "x".repeat(10) }, c)).status, 403);
  assert.equal((await req("POST", "/auth/password", { password: pw, newPassword: "short" }, c)).status, 400);
  const changed = await req("POST", "/auth/password", { password: pw, newPassword: "second password 2" }, c);
  assert.equal(changed.status, 200);
  const fresh = sessionFrom(changed);
  assert.equal((await req("GET", "/auth/me", undefined, other)).status, 401);   // other devices signed out
  assert.equal((await req("GET", "/auth/me", undefined, fresh)).status, 200);   // this one stays in
  assert.equal((await req("POST", "/auth/login", { username: "lich", password: pw }, "")).status, 401);

  const rotated = (await req("POST", "/auth/feed-token", undefined, fresh)).body.user.feedToken;
  assert.notEqual(rotated, reg.user.feedToken);
  assert.equal((await fetch(BASE + "/calendar.ics?token=" + reg.user.feedToken)).status, 401);
  assert.equal((await fetch(BASE + "/calendar.ics?token=" + rotated)).status, 200);

  const { body: t } = await req("POST", "/tasks", { title: "doomed with its owner" }, fresh);
  assert.equal((await req("DELETE", "/auth/account", { password: "wrong one!" }, fresh)).status, 403);
  assert.equal((await req("DELETE", "/auth/account", { password: "second password 2" }, fresh)).status, 200);
  assert.equal((await req("GET", "/auth/me", undefined, fresh)).status, 401);
  assert.equal((await req("POST", "/auth/login", { username: "lich", password: "second password 2" }, "")).status, 401);
  assert.equal((await req("GET", `/tasks/${t.id}`)).status, 404);
});

test("static files are gzipped and revalidate with ETags", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/app.js`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  const etag = res.headers.get("etag");
  assert.ok(etag);
  await res.arrayBuffer();
  const again = await fetch(`http://127.0.0.1:${PORT}/app.js`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
});

test("focus minutes are stored per task and validated", async () => {
  const { body: t } = await req("POST", "/tasks", { title: "Deep work" });
  assert.equal(t.focusMin, 0);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { focusMin: 25 })).body.focusMin, 25);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { focusMin: -5 })).status, 400);
  assert.equal((await req("PATCH", `/tasks/${t.id}`, { focusMin: 2.5 })).status, 400);
});

test("sharing: read-only public list that can be switched off", async () => {
  const { cookie: c } = await register("bard");
  await req("POST", "/tasks", { title: "Public ritual", notes: "secret notes", subtasks: [{ id: "a", text: "hidden step" }] }, c);
  const on = (await req("POST", "/auth/share", { enabled: true }, c)).body.user.shareToken;
  assert.match(on, /^[a-f0-9]{36}$/);
  const pub = await fetch(`${BASE}/share/${on}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("x-robots-tag"), "noindex, nofollow");
  const data = await pub.json();
  assert.equal(data.owner, "bard");
  const t = data.tasks.find((x) => x.title === "Public ritual");
  assert.ok(t && !("notes" in t) && !("subtasks" in t) && !("id" in t));
  assert.equal((await req("POST", "/auth/share", { enabled: false }, c)).body.user.shareToken, null);
  assert.equal((await fetch(`${BASE}/share/${on}`)).status, 404);
  assert.equal((await fetch(`${BASE}/share/not-a-token`)).status, 404);
  assert.equal((await req("POST", "/auth/share", { enabled: true }, "")).status, 401);
});

test("sign out everywhere ends every session", async () => {
  const pw = "everywhere pass 1";
  const a = (await register("wanderer", pw)).cookie;
  const b = sessionFrom(await req("POST", "/auth/login", { username: "wanderer", password: pw }, ""));
  const r = await req("POST", "/auth/logout-all", undefined, a);
  assert.equal(r.status, 200);
  assert.equal(r.body.ended, 2);
  assert.equal((await req("GET", "/auth/me", undefined, a)).status, 401);
  assert.equal((await req("GET", "/auth/me", undefined, b)).status, 401);
});

test("custom spells are stored per user and validated", async () => {
  assert.deepEqual((await req("GET", "/spells")).body, []);
  const spell = { id: "sp1", name: "  Sunday   ritual ", tasks: [{ t: "Sweep the crypt", p: "howl", g: "crypt", d: 2, s: ["broom", " "] }, { t: "Feed the cat", p: "whisper", g: "crypt" }] };
  const saved = (await req("PUT", "/spells", [spell])).body;
  assert.equal(saved[0].name, "Sunday ritual");
  assert.deepEqual(saved[0].tasks[0].s, ["broom"]);
  assert.equal(saved[0].tasks[1].d, null);
  assert.equal((await req("PUT", "/spells", [{ ...spell, tasks: [] }])).status, 400);
  assert.equal((await req("PUT", "/spells", [{ ...spell, tasks: [{ t: "x", p: "boo", g: "crypt" }] }])).status, 400);
  const other = await register("apprentice");
  assert.deepEqual((await req("GET", "/spells", undefined, other.cookie)).body, []); // not shared across accounts
});
