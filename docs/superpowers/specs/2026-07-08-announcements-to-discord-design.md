# Announcements → Discord (Post-on-Publish)

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan
**Apps:** `communityhunts-backend` (primary) + `communityhunts-frontend`

## Goal

When an owner publishes a site announcement (the 🔔 patch-notes bell feature), optionally
push the same announcement to a Discord channel as an embed. A "Post to Discord" toggle in
the create form controls it (default ON). One-directional: site → Discord, create-only.

## Decisions (locked)

| Question | Decision |
|---|---|
| Delivery mechanism | Existing community bot (`DISCORD_BOT_TOKEN`) + new `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` env var. Mirrors `POST /api/tickets`. |
| Message format | Full embed: title, date, each section as an embed field (heading + bulleted items), link to communityhunts.gg. |
| Edit/delete behavior | Post fires **only on create**. Editing or deleting a site announcement never touches Discord. No message-ID bookkeeping. |
| Toggle default | ON in the create form. Not shown on the edit form. |
| Failure handling | Announcement is saved first; Discord post is best-effort and never fails the request. |

## Backend

### Config
- New env var `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` (community Discord channel).
- Reuses existing `DISCORD_BOT_TOKEN`. Bot needs **Send Messages** + **Embed Links** in that channel.
- Add both to `.env.example` with a comment.

### Flow (`routes/announcements.routes.js`)
1. Frontend includes `postToDiscord: boolean` in the existing `POST /api/announcements` body.
   `validateInput` already ignores unknown keys — `postToDiscord` is read off `req.body`
   directly and never stored on the announcement.
2. After `createAnnouncement(...)` succeeds, if `postToDiscord === true` **and** both
   `DISCORD_BOT_TOKEN` and `DISCORD_ANNOUNCEMENTS_CHANNEL_ID` are configured, build and POST
   an embed to `https://discord.com/api/v10/channels/{channelId}/messages` with
   `Authorization: Bot {DISCORD_BOT_TOKEN}` (same call shape as `misc.routes.js` tickets).
3. Discord call is awaited but wrapped so a failure only logs + flips the response field —
   the saved announcement is already returned to the client.
4. Response shape: `{ ...announcement, discord: 'posted' | 'failed' | 'skipped' }`.
   - `'skipped'` = toggle off, or channel/token not configured.

### Embed shape
```js
{
  title: `🔔 ${title}`.slice(0, 256),
  description: `[communityhunts.gg](https://communityhunts.gg)`,
  color: 0xc6f135,                       // site gold accent
  fields: sections.slice(0, 25).map(s => ({
    name: s.heading.slice(0, 256),
    value: s.items.map(i => `• ${i}`).join('\n').slice(0, 1024),
    inline: false,
  })),
  timestamp: new Date(date).toISOString(),
  footer: { text: 'CommunityHunts' },
}
```
Caps mirror the tickets route (field value ≤ 1024, ≤ 25 fields, title ≤ 256). The embed
builder lives in `routes/announcements.routes.js` (or a tiny local helper) — no need to
touch `lib/announcements.js`, which stays a pure store.

### Non-goals
- No PUT/DELETE → Discord sync.
- No storing of the Discord message ID.
- No per-tenant announcement channel yet (single community channel for now; can move to the
  `tenants` row later, same way other Discord channel IDs are configured).

## Frontend (`src/admin/AdminAnnouncements.js`)

- Add a "Post to Discord 🔔" checkbox to the **create** form, default **checked**, styled with
  the existing `G` design tokens. Not rendered on the edit form.
- Send `postToDiscord` with the create request.
- On response:
  - `discord: 'posted'` or `'skipped'` → normal success.
  - `discord: 'failed'` → non-blocking warning: "Announcement published, but the Discord post
    failed." (The announcement still went live.)

## Testing / Rollout

- No test suite. Verify by local boot on `$env:PORT='3101'` (port 3001 may be occupied by
  another session). Curl `POST /api/announcements` with a temp body file (PowerShell mangles
  inline `-d` JSON → use `-d "@file"`). Confirm the embed lands in a test channel.
- Backend is backward-compatible (missing `postToDiscord` = no post) → **ship backend first**,
  frontend after. Prod-verify on communityhunts.gg post-merge (Vercel preview is login-walled).

## Related

- `announcements-bell-feature` memory (the shipped bell + Admin Hub publisher this extends).
- `POST /api/tickets` in `routes/misc.routes.js` — the embed-to-Discord pattern being reused.
