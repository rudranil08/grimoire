# Grimoire 🎃 — The Tasks That Wouldn't Die

A Halloween task manager with a retro horror-poster look. Zero-dependency Node app (Node ≥ 22.13):
static frontend in `public/`, REST API + SQLite (`node:sqlite`) in `server/`.

![CI](https://github.com/rudranil08/grimoire/actions/workflows/ci.yml/badge.svg)

## Quick start

```bash
npm run dev     # → http://localhost:5317 (auto-restarts on server changes)
npm test        # API, auth, parser and frontend checks against throwaway databases
```

No `npm install` needed — there are no dependencies. Optional settings go in `.env` (see `.env.example`).

| Page | What it is |
|---|---|
| `/` | Landing page (shows "Open your Grimoire" when you're signed in) |
| `/signup` · `/login` | Account pages (`?next=/path` returns you where you were) |
| `/app` | The task manager (redirects to `/login` when signed out) |
| `/privacy` | What's stored and why |
| `/share.html#token` | Public read-only poster of someone's list |

> **Upgrading a local install from before accounts:** the first account you sign up inherits existing
> tasks and trophies. This never happens when `NODE_ENV=production`.

## Deploy

Any host that runs Docker or Node 22.13+ works. You need **one persistent disk** for the SQLite file.

```bash
docker build -t grimoire .
docker run -p 8080:8080 -v grimoire-data:/data -e TRUST_PROXY=1 grimoire
```

On a PaaS (Render, Railway, Fly.io…): use the Dockerfile, mount a volume at `/data`, and set
`TRUST_PROXY=1` so HTTPS requests get `Secure` cookies + HSTS and rate limits see real client IPs.
Without Docker: `NODE_ENV=production DB_FILE=/path/on/disk/grimoire.db npm start`.

GitHub Actions runs the test suite on Node 22 and 24 for every push and pull request.

## Features

**Tasks** — priority ("dread": Whisper / Howl / Scream), realm, due date, repeat (daily/weekly/monthly),
notes, checklists (subtasks). Click a tag to change it; double-click a title to rename; drag (or
`Shift+J/K`) to reorder; swipe right/left on phones to slay/banish. Multi-select with `⌘/Ctrl-click` or
`Shift-click` for bulk slay / priority / date / banish. Overdue tasks get a 💤 snooze-to-tomorrow button;
tasks untouched for a week grow cobwebs.

**Quick add** — type naturally: `Buy candy tomorrow !scream #errand every week`.
Dates: `today`, `tomorrow`, `in 3 days`, `next week`, `on friday`, `by halloween`, `oct 31`, `31st October`.
Dread: `!`, `!!`, `!!!` or `!whisper` `!howl` `!scream`. Realm: `#home #work #party #social #errand`.
Repeat: `daily`, `weekly`, `monthly`, `every monday`.
Paste a multi-line list (bullets, numbers and `[ ]` are stripped) to summon one task per line.

**Views** — List, Calendar (drag chips between days to reschedule), Stats (14-night kill-count chart,
streaks, séance time, most-haunted tasks). Tabs: All · Tonight (due today/overdue) · Lurking · Vanquished.

**Search operators** — `is:done` `is:open` `is:late` `is:today` `is:repeat` · `!scream` `!howl` `!whisper` ·
`#work` `#home` `#party` `#social` `#errand` · `due:today` `due:tomorrow` `due:week` `due:none` — mix with words.

**Rituals** — Séance focus timer with a melting candle (minutes are credited to the task) · 10 trophies + nightly 🔥 streak · Spellbook of
ready-made task bundles timed to Oct 31, plus your own spells (select tasks → "Save as spell") ·
Witching Hour challenge (slay 3 in 60 minutes, 11th trophy) · Graveyard for buried tasks (restore or destroy) ·
global undo / redo (`⌘/Ctrl+Z`, `⇧⌘/Ctrl+Shift+Z`) · command palette (`⌘/Ctrl+K`) · 4 themes (Blood Moon, Witching Hour,
Pumpkin Patch, Bone Paper) · daily due-date notifications · print-friendly poster · zen mode ·
"let fate decide" random picker · first-run tour · favicon badge with the lurking count.

**Data** — accounts with per-user data · works offline (ordered change queue, auto-reconnect) ·
JSON export/import · private iCalendar feed · public read-only "Now Showing" share poster (notes and
checklists stay private; switch it off to kill the link) · installable (web manifest + service worker).

### Keyboard
`⌘K` commands · `⌘Z` undo · `N` new · `/` search · `1–4` tabs · `L C S` list/calendar/stats ·
`J/K` move · `Shift+J/K` reorder · `X` slay · `E` rename · `D` duplicate · `P` dread · `R` repeat · `F` séance ·
`T` theme · `Z` zen · `G` fate · `Del` banish · `Esc` close/clear · `?` all shortcuts.

## API

All `/api` routes except `health`, `auth/*` and the token-authorised calendar feed require a session
cookie. Writes must be same-origin JSON (CSRF guard).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | `{ username, password }` → sets `grimoire_session` (HttpOnly, SameSite=Lax) |
| GET | `/api/auth/me` | current user (incl. private `feedToken`) |
| GET | `/api/auth/session` | `{ user }` or `{ user: null }` — never 401 (for public pages) |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/logout-all` | end every session for this account |
| POST | `/api/auth/password` | `{ password, newPassword }` — signs out other sessions |
| POST | `/api/auth/feed-token` | rotate the calendar feed token |
| POST | `/api/auth/share` | `{ enabled }` — turn the public share poster on/off |
| GET | `/api/share/:token` | public read-only list (titles, dates, dread, realm, repeat, done) |
| DELETE | `/api/auth/account` | `{ password }` — deletes the user and all their data |
| GET / POST | `/api/tasks` | task fields: `title, notes, subtasks[], repeat, priority, tag, due, done, order, focusMin` |
| GET / PATCH / DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/bulk` | array of tasks, all-or-nothing |
| PUT | `/api/tasks/reorder` | `{ ids: string[] }` |
| DELETE | `/api/tasks?done=true` | bury completed tasks in the graveyard |
| GET / DELETE | `/api/graveyard` | list / permanently destroy buried tasks |
| POST | `/api/graveyard/restore` | `{ ids: string[] }` |
| GET / PUT | `/api/trophies` | `{ slain, unlocked, days, focusMin, log }` |
| GET / PUT | `/api/spells` | your saved spells: `[{ id, name, tasks: [{ t, p, g, d, s }] }]` |
| GET | `/api/export` · POST `/api/import` | JSON backup (import validates first, then replaces in one transaction) |
| GET | `/api/calendar.ics?token=…` | iCalendar feed of unfinished dated tasks (RRULE for repeats) |

`priority`: whisper · howl · scream — `tag`: crypt · ledger · cauldron · coven · errand —
`repeat`: "" · daily · weekly · monthly — `due`: `YYYY-MM-DD` or `""`.

### Configuration
| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `5317` / `127.0.0.1` | |
| `DB_FILE` | `data/grimoire.db` | |
| `NODE_ENV` | — | `production` binds `0.0.0.0` and disables legacy-data claiming |
| `TRUST_PROXY` | off | `1` behind a proxy/PaaS: trust `X-Forwarded-For` / `-Proto` |
| `SECURE_COOKIES` | off | `1` to force `Secure` cookies (HTTPS without a proxy) |
| `AUTH_RATE_LIMIT` | `10` | login/sign-up attempts per minute per IP |
| `WRITE_RATE_LIMIT` | `300` | API writes per minute per account |

Passwords are hashed with scrypt; session tokens are stored hashed (SHA-256) and expire after 30 days.
Static files are served gzipped with ETags (304 revalidation).
