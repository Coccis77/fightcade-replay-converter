# fc2mp4 serve with accounts — Design

Date: 2026-10-05
Builds on: `2026-10-04-web-page-design.md` (v0.7–v0.9.1: `fc2mp4 serve`, queue, `--keep`).
Target: a small public deployment on a VPS behind Caddy (HTTPS), for very few users.

## 1. Goal and understanding

- **User's words:** an admin user; credentials set on first visit (on a separate page, `/admin`, not
  the main page); user management — add a user with a maximum number of replays per day (3 by
  default); the admin is unlimited; no separation by user, just an "uploaded by" filter.
- **Decisions taken:** first-time setup instead of default credentials (no takeover window); the admin
  gives each user a username and a temporary password, changed at first login; storage in one JSON
  file (very few users), no new dependencies.
- **Unchanged:** conversions (one at a time, same queue, same `convert()`), `--keep`, Docker image,
  CLI commands.

### Success criteria

1. On a fresh server, `/` says "Not set up yet"; `/admin` creates the admin account once, then only
   offers the admin login.
2. The admin adds users (username, temporary password, daily limit, default 3), changes limits,
   resets passwords, disables and deletes users.
3. A user logs in on `/`, must choose a password the first time, converts replays and downloads them;
   a 4th new conversion in a day (limit 3) is refused with a clear message. The admin is never limited.
4. Everyone logged in sees one shared list of conversions with an "Uploaded by" filter; the admin can
   delete an entry (MP4 and entry).
5. Nothing is reachable without logging in, except the login/setup pages; admin routes need the admin.
6. Users, sessions and history survive a restart; a crash during a write never corrupts them.

## 2. Pages

- **`/`** — not set up: "Not set up yet". Logged out: login form. Temporary password: "Choose your
  password" (new password twice, ≥ 8 characters). Logged in: the converter (link box, Convert, the
  live status of the replays the user submitted in this tab, as today), "N of M replays left today"
  (admin: no counter), the shared list, and Log out.
- **Shared list** — newest first: replay ID, uploaded by, date, status (waiting / converting /
  done / failed), Download link when done; filter "Uploaded by: Everyone | <user>…"; admin: a Delete
  button per entry (confirmation in the page, not a browser dialog).
- **`/admin`** — no admin yet: "Create the admin account" (username, password twice, ≥ 8 characters).
  Otherwise admin login, then **Users**: one row per user (username, status active/disabled/must change
  password, limit, used today) with Change limit, Reset password (shows the new temporary password once),
  Disable/Enable, Delete (confirmation in the page); an "Add user" form (username, temporary password,
  limit default 3). Link to `/`.
- Usernames: 1–32 characters `[A-Za-z0-9_.-]`, case-insensitive unique. Passwords: ≥ 8 characters.

## 3. Rules

- **Counting:** a request counts toward the user's daily limit only when it queues a new conversion
  (not when the MP4 already exists or the replay is already waiting/converting). A failed conversion is
  refunded. Admin requests never count.
- **Day:** local midnight of the server (`TZ` in Docker; README says so).
- **At the limit:** `429 {"error":"You've used your 3 replays for today","hint":"Back tomorrow"}`.
- **Uploaded by:** the user whose request queued the conversion (the first requester). A replay already
  on disk without a history entry (from an older version) gets an entry when first requested, attributed
  to that requester, free.
- **Deleted user:** cannot log in; their history entries keep their name. **Disabled user:** cannot log
  in; their sessions are removed.
- **Admin delete of a conversion:** removes the MP4 (if present) and the entry; refused while it is
  waiting or converting. `--keep` deletions also remove the entries.

## 4. HTTP interface

All JSON; POST bodies must be `application/json` (≤ 4 KB, as today). Unauthenticated → `401`, not admin
→ `403`. Routes:

| Route | Who | Does |
|---|---|---|
| `GET /` , `GET /admin` | anyone | the pages |
| `GET /api/state` | anyone | `{setUp: bool, user: null \| {name, admin, mustChangePassword, limit, usedToday}}` |
| `POST /api/setup` `{name, password}` | anyone, only while no admin | creates the admin, logs in |
| `POST /api/login` `{name, password}` | anyone | sets the session cookie; 10 attempts/min per IP, then `429` |
| `POST /api/logout` | user | ends the session |
| `POST /api/password` `{current, password}` | user | changes the password, clears "must change" |
| `POST /api/jobs` `{url}` | user (password changed) | as today + limit check → `{id}` |
| `GET /api/jobs/<id>`, `GET /api/jobs/<id>/file` | user | as today |
| `GET /api/conversions?by=<name>` | user | the shared list (filtered) |
| `DELETE /api/conversions/<id>` | admin | deletes MP4 + entry |
| `GET /api/admin/users` | admin | users with usage today |
| `POST /api/admin/users` `{name, password, limit}` | admin | adds a user (must change password) |
| `PATCH /api/admin/users/<name>` `{limit?, disabled?, password?}` | admin | changes; a new password sets "must change" |
| `DELETE /api/admin/users/<name>` | admin | deletes (not the admin itself) |

## 5. Storage and security

- **File:** `<outputDir>/fc2mp4-data.json`, version 1:
  `{version, users: [{name, admin, passwordHash, salt, mustChangePassword, limit, disabled, createdAt}],
  sessions: [{tokenHash, name, expiresAt}], conversions: [{id, by, requestedAt, state, finishedAt?,
  error?}], usage: [{name, day, count}]}`. Written to a temporary file then renamed (atomic); the server
  is the only regular writer (`reset-admin` is the exception, see below). Missing file = fresh server. Corrupt file = startup error with the path, never
  overwritten.
- **Passwords:** `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key) with a random 16-byte salt; compared
  with `timingSafeEqual`.
- **Sessions:** random 32-byte token in cookie `fc2mp4_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Max-Age` 30 days, `Secure` when `X-Forwarded-Proto: https`); only its SHA-256 is stored; expired
  sessions pruned at startup.
- **Login throttle:** in memory, 10 failed attempts per IP per minute (IP from `X-Forwarded-For` only
  when the request comes from 127.0.0.1/::1, i.e. Caddy on the same machine).
- **`fc2mp4 reset-admin`:** removes the admin account (and its sessions) from the data file of the
  output folder; `/admin` then shows the setup again. Works while `serve` runs (e.g. `docker exec <c>
  fc2mp4 reset-admin`): `serve` rereads the data file whenever its modification time differs from its
  own last write, before every read and every change, so an outside change is never overwritten.
- **Data file outside the web root:** the file route only serves `<id>.mp4` (unchanged), so the data
  file is never downloadable.

## 6. Testing

- **Unit:** store (atomic write, missing file, corrupt file refused, version), passwords (hash/verify,
  wrong password), sessions (create, lookup, expiry, logout, disabled user), limits (counting rules,
  refunds, day change, admin unlimited), access rules for every route (401/403), setup only once, login
  throttle, admin user routes (validation, duplicates case-insensitive, cannot delete admin), shared list
  + filter, admin delete (refused while converting), `--keep` removes entries, `reset-admin`.
- **Real (Claude, Mac, Chrome):** fresh folder → `/admin` setup → add user → log in as the user on
  another browser profile/incognito → choose password → convert, see "2 of 3 left" → limit reached after
  3 new replays → filter by user → admin deletes an entry.
- **Real (user, WSL Docker):** same flow from Windows.

## 7. Out of scope

- HTTPS itself (Caddy; README gets a Caddyfile example), email, invite links, self sign-up, per-user
  storage separation, replay length limits beyond `--max-duration`, multiple admins.
