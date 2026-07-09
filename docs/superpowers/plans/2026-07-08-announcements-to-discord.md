# Announcements → Discord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an owner publishes a site announcement with the "Post to Discord" toggle on, post the same announcement to a Discord channel as an embed.

**Architecture:** One-directional (site → Discord), create-only. The backend's existing `POST /api/announcements` handler, after saving, best-effort posts a Discord embed via the existing community bot (`DISCORD_BOT_TOKEN`) to a new `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` channel — reusing the exact embed-POST pattern already in `routes/misc.routes.js` (`/api/tickets`). The frontend adds a default-on checkbox to the create form and surfaces a non-blocking warning if the post fails.

**Tech Stack:** Node.js/Express (backend, no build step, no test runner), React/CRA (frontend). Discord REST API v10.

## Global Constraints

- **Two separate git repos.** Backend: `communityhunts-backend/` → `RandyCabbages/communityhunts-backend`. Frontend: `communityhunts-frontend/` → `GooferG/communityhunts-frontend`. Run git only inside the app subdirectory. The wrapper dir is not a repo.
- **No `Co-Authored-By` / Claude authorship trailers** in any commit message.
- **Backend ships first** — it is backward-compatible (missing `postToDiscord` = no post), so it can deploy before the frontend sends the flag.
- **Backend has no test suite** — "test" steps are a local boot + curl. Boot on `$env:PORT='3101'` (port 3001 is often occupied by another session; a 200 from 3001 may be a stale instance).
- **PowerShell curl JSON gotcha:** inline `-d "{\"a\":1}"` gets mangled → body-parser 500. Write the JSON body to a temp file and use `-d "@file"`.
- **Frontend build gate:** `CI=true npm run build` must print "Compiled successfully" (Vercel turns warnings into errors). Do not push straight to `main` to test — use a branch + Vercel preview.
- **Auth gates on Discord ID, never display name.** The announcements POST is already `requireAuth, requirePlatformAdmin` — do not change the gate.

---

## File Structure

**Backend (`communityhunts-backend/`)**
- Modify `routes/announcements.routes.js` — add embed builder + best-effort Discord post inside the POST handler; accept `botToken` + `announcementsChannelId` from deps.
- Modify `server.js:348` — pass `botToken` + `announcementsChannelId` into the route factory.
- Modify `.env.example` — document `DISCORD_ANNOUNCEMENTS_CHANNEL_ID`.

**Frontend (`communityhunts-frontend/`)**
- Modify `src/admin/AdminAnnouncements.js` — `postToDiscord: true` in `empty()`, a checkbox in the create form (hidden on edit), include the flag on create, surface a warning on `discord: 'failed'`.
- `src/admin/adminApi.js` — **no change**; `createAnnouncement(a)` already serializes the whole object (so `postToDiscord` rides along) and returns the parsed response (so `.discord` is readable).

---

## Task 1: Backend — post announcement to Discord on create

**Files:**
- Modify: `communityhunts-backend/routes/announcements.routes.js`
- Modify: `communityhunts-backend/server.js:345-348`
- Modify: `communityhunts-backend/.env.example`

**Interfaces:**
- Consumes: `announcements.createAnnouncement(body, userId)` → announcement object `{ id, title, date, sections: [{heading, items[]}], createdBy, updatedAt }` (unchanged, from `lib/announcements.js`).
- Produces: `POST /api/announcements` response is now `{ ...announcement, discord: 'posted' | 'failed' | 'skipped' }`. The frontend (Task 2) reads `.discord`.

- [ ] **Step 1: Add the embed builder + poster + deps to the route module**

In `communityhunts-backend/routes/announcements.routes.js`, replace the top of the file (the header comment through the `const { ... } = deps;` line) with the version below, adding the two new deps and the two helper functions above the router:

```js
// Platform-wide announcements ("patch notes"). Public read; owner-only writes.
//   GET    /api/announcements      — public, newest-first (≤20)
//   POST   /api/announcements      — platform admin only (optional Discord cross-post)
//   PUT    /api/announcements/:id  — platform admin only
//   DELETE /api/announcements/:id  — platform admin only

const express = require('express');

const EMBED_COLOR = 0x7c3aed; // community accent (violet) — matches the live site palette
const SITE_URL = 'https://communityhunts.gg';

// Build a Discord embed from an announcement. Caps mirror routes/misc.routes.js:
// title ≤ 256, field value ≤ 1024, ≤ 25 fields. '​' is a zero-width space —
// Discord rejects empty field name/value strings.
function buildAnnouncementEmbed(a) {
  return {
    title: `🔔 ${a.title}`.slice(0, 256),
    description: `[communityhunts.gg](${SITE_URL})`,
    color: EMBED_COLOR,
    fields: (a.sections || []).slice(0, 25).map(s => ({
      name: String(s.heading || '​').slice(0, 256),
      value: ((s.items || []).map(i => `• ${i}`).join('\n') || '​').slice(0, 1024),
      inline: false,
    })),
    timestamp: new Date(a.date || Date.now()).toISOString(),
    footer: { text: 'CommunityHunts' },
  };
}

// Best-effort POST to Discord. Throws on non-2xx so the caller can flag 'failed'.
async function postAnnouncementToDiscord(a, botToken, channelId) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [buildAnnouncementEmbed(a)] }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Discord returned ${r.status}: ${detail.slice(0, 200)}`);
  }
}

module.exports = function announcementsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, announcements, botToken, announcementsChannelId } = deps;
  const router = express.Router();
```

Leave the rest of the file (the GET/PUT/DELETE handlers and `return router;`) unchanged for now — the POST handler is replaced in the next step.

- [ ] **Step 2: Make the POST handler cross-post after saving**

In the same file, replace the existing POST handler:

```js
  router.post('/api/announcements', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = announcements.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    res.json(announcements.createAnnouncement(req.body, req.user.id));
  });
```

with:

```js
  router.post('/api/announcements', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = announcements.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    const a = announcements.createAnnouncement(req.body, req.user.id);

    // Optional Discord cross-post. The announcement is already saved — a Discord
    // failure only flips the status field, it never fails the request.
    let discord = 'skipped';
    if (req.body.postToDiscord && botToken && announcementsChannelId) {
      try {
        await postAnnouncementToDiscord(a, botToken, announcementsChannelId);
        discord = 'posted';
        console.log(`[announce] cross-posted announcement ${a.id} to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[announce] Discord cross-post failed:', e.message);
      }
    }
    res.json({ ...a, discord });
  });
```

- [ ] **Step 3: Pass the bot token + channel id into the route in `server.js`**

In `communityhunts-backend/server.js`, replace line 348:

```js
app.use(require('./routes/announcements.routes')({ requireAuth, requirePlatformAdmin, announcements }));
```

with:

```js
app.use(require('./routes/announcements.routes')({
  requireAuth, requirePlatformAdmin, announcements,
  botToken: process.env.DISCORD_BOT_TOKEN,
  announcementsChannelId: process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
}));
```

- [ ] **Step 4: Document the new env var**

In `communityhunts-backend/.env.example`, add this line near the other `DISCORD_*` channel entries (after `DISCORD_WINNERS_CHANNEL_ID`):

```
DISCORD_ANNOUNCEMENTS_CHANNEL_ID=   # channel the community bot posts site announcements into (optional; blank = never cross-post)
```

- [ ] **Step 5: Boot the server locally and verify it starts**

From `communityhunts-backend/`, boot on a free port (3001 may hold a stale instance). Dummy Discord creds are enough to boot (see the backend-local-dev notes; run `npm install` first if `dotenv`/`nodemon` are missing):

Run (PowerShell):
```powershell
$env:PORT='3101'; node server.js
```
Expected: the process logs `[announce] Loaded N announcements ...` and a listening line on 3101 with no stack trace. Leave it running for the next step (or background it).

- [ ] **Step 6: Verify the `discord` status field without a real channel (skipped path)**

This confirms the code path returns `discord: 'skipped'` when the channel isn't configured, and that an unauthenticated call is still rejected (proving the gate is intact). Because the POST is platform-admin gated, a straight curl without a session returns 401 — that is the expected "gate works" result. Write a body file and POST it:

Run (PowerShell, in a second terminal):
```powershell
'{"title":"Test note","sections":[{"heading":"Fixes","items":["did a thing"]}],"postToDiscord":true}' | Out-File -Encoding ascii $env:TEMP\ann.json
curl.exe -s -X POST http://localhost:3101/api/announcements -H "Content-Type: application/json" -d "@$env:TEMP\ann.json"
```
Expected: `{"error":...}` with HTTP 401/403 (no admin session) — **not** a 500 and not a body-parser crash. This proves the route parses the body and the auth gate fires. Full happy-path embed delivery is verified post-deploy in Step 8 with a real session + channel.

- [ ] **Step 7: Commit the backend change**

Run (from `communityhunts-backend/`):
```bash
git pull origin main
git add routes/announcements.routes.js server.js .env.example
git commit -m "feat: optional Discord cross-post when publishing an announcement"
git push origin main
```
Expected: Railway auto-deploys in ~1-3 min.

- [ ] **Step 8: Post-deploy prod smoke test (needs the env var set + bot in channel)**

Preconditions (do in Railway + Discord, one-time): set `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` to a **test** channel's ID; ensure the community bot (the one behind `DISCORD_BOT_TOKEN`) is in that guild with **Send Messages** + **Embed Links** in that channel.

Then, logged in as the owner on communityhunts.gg, publish a throwaway announcement with the toggle on (this is exercised fully via the frontend in Task 2 — if Task 2 isn't deployed yet, temporarily POST with a valid admin session). Expected: an embed appears in the test channel (🔔 title, section fields, violet bar, communityhunts.gg link) and the API response contains `"discord":"posted"`. Delete the test announcement afterward. Move the env var to the real announcement channel when ready.

---

## Task 2: Frontend — "Post to Discord" toggle + failure warning

**Files:**
- Modify: `communityhunts-frontend/src/admin/AdminAnnouncements.js`

**Interfaces:**
- Consumes: `createAnnouncement(cleaned)` from `adminApi.js` → resolves to the parsed response object `{ ...announcement, discord }` (no change to `adminApi.js`).
- Produces: nothing downstream (leaf UI).

- [ ] **Step 1: Default the toggle on in new drafts**

In `communityhunts-frontend/src/admin/AdminAnnouncements.js`, replace the `empty()` factory (lines 5-8):

```js
const empty = () => ({
  title: '', date: new Date().toISOString().slice(0, 10),
  sections: [{ heading: '', items: [''] }],
});
```

with:

```js
const empty = () => ({
  title: '', date: new Date().toISOString().slice(0, 10),
  sections: [{ heading: '', items: [''] }],
  postToDiscord: true,
});
```

- [ ] **Step 2: Surface a Discord-failure warning on create**

In the same file, replace the `save()` try/catch (lines 32-37):

```js
    try {
      if (a.id) await updateAnnouncement(a.id, cleaned);
      else await createAnnouncement(cleaned);
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); }
```

with:

```js
    try {
      if (a.id) {
        await updateAnnouncement(a.id, cleaned);
      } else {
        const r = await createAnnouncement(cleaned);
        if (r && r.discord === 'failed') setErr('Announcement published, but the Discord post failed.');
      }
      setEditing(null);
      load();
    } catch (e) { setErr(e.message); }
```

Note: `cleaned` already spreads `...a`, so `postToDiscord` is carried on create. On edit the backend ignores it (only title/date/sections are read), so no extra stripping is needed. The warning shows above the list after the form closes.

- [ ] **Step 3: Add the checkbox to the create form (hidden on edit)**

In the same file, insert this block immediately **before** the action-button row (the `<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>` at line 134):

```jsx
          {!editing.id && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: C.t2, fontFamily: C.body, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={editing.postToDiscord !== false}
                onChange={e => upd('postToDiscord', e.target.checked)}
                style={{ width: 16, height: 16, accentColor: C.accent || C.gold, cursor: 'pointer' }} />
              Post to Discord 🔔
            </label>
          )}
```

`editing.postToDiscord !== false` keeps it checked for drafts created before this field existed.

- [ ] **Step 4: Verify the build compiles**

Run (from `communityhunts-frontend/`):
```bash
git pull --ff-only
CI=true npm run build
```
Expected: "Compiled successfully". CRA will NOT flag a mis-wired prop — eyeball that the checkbox `onChange` calls `upd('postToDiscord', ...)` and that the block is inside the `{editing && (...)}` region.

- [ ] **Step 5: Commit on a branch and open a preview**

Run (from `communityhunts-frontend/`):
```bash
git checkout -b feat/announcement-discord-toggle
git add src/admin/AdminAnnouncements.js
git commit -m "feat: Post to Discord toggle on announcement publish"
git push origin feat/announcement-discord-toggle
```
Expected: Vercel builds a preview URL. Open the Admin Hub → Announcements on the preview, confirm the checkbox appears (checked) on **+ New Announcement** and is absent on **Edit**. Merge to `main` after the backend (Task 1) is live and a real publish posts to the test channel.

---

## Self-Review

- **Spec coverage:** New env var (T1 S4) ✓; existing bot delivery (T1 S1-3) ✓; full embed with title/date/section-fields/link (T1 S1 `buildAnnouncementEmbed`) ✓; create-only, no PUT/DELETE sync (POST handler only) ✓; best-effort, never fails request (T1 S2 try/catch) ✓; `discord` status field (T1 S2) ✓; toggle default ON (T2 S1) ✓; toggle hidden on edit (T2 S3 `!editing.id`) ✓; failure warning (T2 S2) ✓; backend-first rollout (Global Constraints + task order) ✓.
- **Deviation from spec:** embed color is `0x7c3aed` (violet) not the spec's `0xc6f135` (gold) — the frontend CLAUDE.md marks the lime/gold palette stale and the live site is violet. It is a single named constant (`EMBED_COLOR`), trivially changed if the gold is preferred.
- **Placeholder scan:** none — all steps carry literal code/commands.
- **Type consistency:** `postToDiscord` (boolean) set in `empty()`, read via `editing.postToDiscord`, sent in `cleaned`, read server-side as `req.body.postToDiscord`; response `discord` string set in T1 S2 and read in T2 S2 — consistent throughout.
