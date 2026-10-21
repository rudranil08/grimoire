// SQLite persistence using Node's built-in driver (no dependencies).
// Every task belongs to a user; `db.forUser(id)` returns a store scoped to that user's rows.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";

export const PRIORITIES = ["whisper", "howl", "scream"];
export const TAGS = ["crypt", "ledger", "cauldron", "coven", "errand"];
export const REPEATS = ["", "daily", "weekly", "monthly"];

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      priority     TEXT NOT NULL DEFAULT 'whisper',
      tag          TEXT NOT NULL DEFAULT 'crypt',
      due          TEXT NOT NULL DEFAULT '',
      done         INTEGER NOT NULL DEFAULT 0,
      sort_order   REAL NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      feed_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
  `);

  // Column migrations (added after v1).
  const cols = () => db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  const addCol = (name, ddl) => { if (!cols().includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`); };
  addCol("notes", "notes TEXT NOT NULL DEFAULT ''");
  addCol("archived_at", "archived_at INTEGER"); // set = buried in the graveyard
  addCol("repeat", "repeat TEXT NOT NULL DEFAULT ''");
  addCol("subtasks", "subtasks TEXT NOT NULL DEFAULT '[]'");
  addCol("focus_min", "focus_min INTEGER NOT NULL DEFAULT 0"); // séance minutes spent on this task
  addCol("user_id", "user_id TEXT"); // NULL = created before accounts existed (claimed by the first user)
  db.exec("CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, archived_at)");
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "share_token")) {
    db.exec("ALTER TABLE users ADD COLUMN share_token TEXT"); // NULL = sharing off
  }

  const q = {
    all: db.prepare("SELECT * FROM tasks WHERE user_id = ? AND archived_at IS NULL ORDER BY sort_order, created_at"),
    archived: db.prepare("SELECT * FROM tasks WHERE user_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC"),
    archiveDone: db.prepare("UPDATE tasks SET archived_at = ? WHERE user_id = ? AND done = 1 AND archived_at IS NULL"),
    unarchive: db.prepare("UPDATE tasks SET archived_at = NULL WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL"),
    purgeArchived: db.prepare("DELETE FROM tasks WHERE user_id = ? AND archived_at IS NOT NULL"),
    get: db.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?"),
    exists: db.prepare("SELECT 1 FROM tasks WHERE id = ?"),
    minOrder: db.prepare("SELECT COALESCE(MIN(sort_order), 0) AS m FROM tasks WHERE user_id = ?"),
    insert: db.prepare(`INSERT INTO tasks (id, user_id, title, notes, subtasks, repeat, priority, tag, due, done, focus_min, sort_order, created_at, completed_at)
                        VALUES (:id, :user_id, :title, :notes, :subtasks, :repeat, :priority, :tag, :due, :done, :focus_min, :sort_order, :created_at, :completed_at)`),
    update: db.prepare(`UPDATE tasks SET title = :title, notes = :notes, subtasks = :subtasks, repeat = :repeat, priority = :priority, tag = :tag, due = :due,
                        done = :done, focus_min = :focus_min, sort_order = :sort_order, completed_at = :completed_at WHERE id = :id AND user_id = :user_id`),
    remove: db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?"),
    removeAll: db.prepare("DELETE FROM tasks WHERE user_id = ?"),
    setOrder: db.prepare("UPDATE tasks SET sort_order = ? WHERE id = ? AND user_id = ?"),
    count: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    metaDel: db.prepare("DELETE FROM meta WHERE key = ?"),

    userCount: db.prepare("SELECT COUNT(*) AS n FROM users"),
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    userByFeed: db.prepare("SELECT * FROM users WHERE feed_token = ?"),
    insertUser: db.prepare("INSERT INTO users (id, username, pass_hash, feed_token, created_at) VALUES (?, ?, ?, ?, ?)"),
    claimLegacy: db.prepare("UPDATE tasks SET user_id = ? WHERE user_id IS NULL"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    session: db.prepare("SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    userSessionsDel: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    setPass: db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?"),
    setFeed: db.prepare("UPDATE users SET feed_token = ? WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    passHash: db.prepare("SELECT pass_hash FROM users WHERE id = ?"),
    setShare: db.prepare("UPDATE users SET share_token = ? WHERE id = ?"),
    userByShare: db.prepare("SELECT * FROM users WHERE share_token = ?"),
  };

  const toApi = (r) => r && ({
    id: r.id, title: r.title, notes: r.notes, subtasks: JSON.parse(r.subtasks || "[]"), repeat: r.repeat, priority: r.priority, tag: r.tag, due: r.due,
    done: !!r.done, order: r.sort_order, createdAt: r.created_at, completedAt: r.completed_at, focusMin: r.focus_min ?? 0,
    ...(r.archived_at ? { buriedAt: r.archived_at } : {}),
  });
  const toRow = (t, uid) => ({
    id: t.id, user_id: uid, title: t.title, notes: t.notes ?? "", subtasks: JSON.stringify(t.subtasks ?? []), repeat: t.repeat ?? "",
    priority: t.priority, tag: t.tag, due: t.due,
    done: t.done ? 1 : 0, focus_min: t.focusMin ?? 0, sort_order: t.order, created_at: t.createdAt, completed_at: t.completedAt ?? null,
  });
  const publicUser = (u) => u && { id: u.id, username: u.username, feedToken: u.feed_token, shareToken: u.share_token ?? null, createdAt: u.created_at };

  const tx = (fn) => {
    db.exec("BEGIN");
    try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };

  function forUser(uid) {
    const store = {
      list: () => q.all.all(uid).map(toApi),
      get: (id) => toApi(q.get.get(id, uid)),
      exists: (id) => !!q.exists.get(id), // ids are global primary keys
      create(input) {
        const now = Date.now();
        const t = {
          id: input.id || randomUUID(),
          title: input.title, notes: input.notes ?? "", subtasks: input.subtasks ?? [], repeat: input.repeat ?? "",
          priority: input.priority ?? "whisper", tag: input.tag ?? "crypt", due: input.due ?? "",
          done: !!input.done,
          focusMin: input.focusMin ?? 0,
          order: input.order ?? q.minOrder.get(uid).m - 1,
          createdAt: input.createdAt ?? now,
          completedAt: input.done ? input.completedAt ?? now : null,
        };
        q.insert.run(toRow(t, uid));
        return toApi(q.get.get(t.id, uid));
      },
      update(id, patch) {
        const cur = toApi(q.get.get(id, uid));
        if (!cur) return null;
        const next = { ...cur, ...patch };
        if ("done" in patch && patch.done !== cur.done) next.completedAt = patch.done ? Date.now() : null;
        const { created_at, ...row } = toRow(next, uid); // created_at is immutable
        q.update.run(row);
        return toApi(q.get.get(id, uid));
      },
      replaceAll: (inputs) => tx(() => { q.removeAll.run(uid); return inputs.map((i) => store.create(i)); }),
      createMany: (inputs) => tx(() => inputs.map((i) => store.create(i))),
      remove: (id) => q.remove.run(id, uid).changes > 0,
      buryDone: () => q.archiveDone.run(Date.now(), uid).changes,
      graveyard: () => q.archived.all(uid).map(toApi),
      restore: (ids) => tx(() => ids.reduce((n, id) => n + q.unarchive.run(id, uid).changes, 0)),
      emptyGraveyard: () => q.purgeArchived.run(uid).changes,
      reorder: (ids) => tx(() => ids.forEach((id, i) => q.setOrder.run(i, id, uid))),
      isEmpty: () => q.count.get(uid).n === 0,
      getMeta: (key) => { const r = q.metaGet.get(`${key}:${uid}`); return r ? JSON.parse(r.value) : null; },
      setMeta: (key, value) => { q.metaSet.run(`${key}:${uid}`, JSON.stringify(value)); return value; },
    };
    return store;
  }

  return {
    forUser,
    close: () => db.close(),

    // ---- users & sessions ----
    findUser: (username) => q.userByName.get(username),
    userById: (id) => publicUser(q.userById.get(id)),
    userByFeedToken: (token) => publicUser(q.userByFeed.get(token)),
    // Creates a user. The very first account inherits tasks/trophies made before accounts existed.
    createUser(username, passHash, { claimLegacy = true } = {}) {
      return tx(() => {
        const first = claimLegacy && q.userCount.get().n === 0;
        const id = randomUUID();
        q.insertUser.run(id, username, passHash, randomBytes(24).toString("hex"), Date.now());
        let claimed = 0;
        if (first) {
          claimed = q.claimLegacy.run(id).changes;
          const legacy = q.metaGet.get("trophies");
          if (legacy) { q.metaSet.run(`trophies:${id}`, legacy.value); q.metaDel.run("trophies"); }
        }
        return { user: publicUser(q.userById.get(id)), claimed };
      });
    },
    createSession(userId) {
      const token = randomBytes(32).toString("hex");
      q.purgeSessions.run(Date.now());
      q.insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL);
      return { token, maxAge: SESSION_TTL / 1000 };
    },
    sessionUser(token) {
      if (!token) return null;
      const r = q.session.get(sha256(token));
      if (!r || r.expires_at < Date.now()) return null;
      return publicUser(r);
    },
    deleteSession: (token) => token && q.deleteSession.run(sha256(token)),
    passHashFor: (uid) => q.passHash.get(uid)?.pass_hash,
    endAllSessions: (uid) => q.userSessionsDel.run(uid).changes,
    // New password signs out every existing session.
    setPassword: (uid, hash) => tx(() => { q.setPass.run(hash, uid); q.userSessionsDel.run(uid); }),
    setSharing(uid, on) { q.setShare.run(on ? randomBytes(18).toString("hex") : null, uid); return publicUser(q.userById.get(uid)); },
    // Public, read-only view of a user's live tasks: no notes, checklists or ids.
    sharedList(token) {
      const u = token && q.userByShare.get(token);
      if (!u) return null;
      const tasks = q.all.all(u.id).map((r) => ({ title: r.title, due: r.due, priority: r.priority, tag: r.tag, done: !!r.done, repeat: r.repeat }));
      return { owner: u.username, tasks };
    },
    rotateFeedToken(uid) { q.setFeed.run(randomBytes(24).toString("hex"), uid); return publicUser(q.userById.get(uid)); },
    deleteUser: (uid) => tx(() => {
      q.removeAll.run(uid);
      q.metaDel.run(`trophies:${uid}`);
      q.deleteUser.run(uid); // sessions cascade
    }),
  };
}
