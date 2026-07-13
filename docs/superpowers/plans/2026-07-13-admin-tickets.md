# Admin Tickets/Suggestions Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` tracking.

**Goal:** Persist bug-tickets/suggestions and give platform owners an admin panel to triage them,
keeping the Discord doorbell (now best-effort + live status embeds).

**Architecture:** Clone the shipped Shop Requests stack — `hunts_kv`-backed `lib/tickets.js`, a
`requirePlatformAdmin` DI router, an admin tab, and `PHASE_META` live-embed PATCH. Tickets are
platform-level (platform bot via `getPlatformBotToken()`, never `req.tenant`).

**Tech Stack:** Node/Express + `node:test` (backend); React CRA (frontend).

## Global Constraints

- Backend tests run as `node --test lib/*.test.js routes/*.test.js` (Node 24 quirk).
- Backend uses `getPlatformBotToken()` for the Discord token — NEVER `req.tenant.discordBotToken`.
- Ticket submit stays PUBLIC (no requireAuth) + per-IP rate-limited; admin routes `requirePlatformAdmin`.
- No new env vars. Reuse `DISCORD_TICKETS_CHANNEL_ID` / `DISCORD_SUGGESTIONS_CHANNEL_ID`.
- Frontend: new UI → new file; tokens via `useTheme()`; `CI=true npm run build` must compile clean.
- No `Co-Authored-By` / Claude attribution in commits or PRs.
- Ship backend PR first, then frontend PR. Do NOT self-merge — Cabbage/owner reviews.

## File Structure

**Backend (`communityhunts-backend/`):**
- Create `lib/tickets.js` — persistence (clone of `lib/cardRequests.js`).
- Create `lib/tickets.test.js` — store unit tests.
- Create `routes/adminTickets.routes.js` — admin CRUD + embed PATCH (clone of `cardRequests.routes.js` admin half).
- Create `routes/adminTickets.routes.test.js` — admin route tests.
- Modify `routes/misc.routes.js` — `POST /api/tickets` persist-first + best-effort.
- Modify `routes/misc.routes.test.js` — best-effort + persistence assertions.
- Modify `server.js` — init + wire `tickets`, mount admin router.
- `.gitignore` — add `tickets.json`.

**Frontend (`communityhunts-frontend/`):**
- Create `src/admin/AdminTickets.js` — admin tab (clone of `AdminShopRequests.js`).
- Modify `src/admin/adminApi.js` — `getTickets`/`updateTicket`/`deleteTicket`.
- Modify `src/admin/AdminLayout.js` — Tickets tab (platformOnly).
- Modify `src/App.js` — import + route under both admin mounts.
- Modify `src/pages/hub/TicketModal.js` — soften error copy (submit rarely fails now).

---

## Task 1: `lib/tickets.js` + unit tests

**Files:** Create `lib/tickets.js`, `lib/tickets.test.js`.

**Interfaces — Produces:**
`initTickets({pgPool})`, `listTickets()`, `validateUpdate(patch)`, `createTicket(fields, sessionUser|null)`,
`updateTicket(id, patch)`, `setDiscordMessage(id, {messageId, channelId})`, `deleteTicket(id)`,
`STATUSES = ['new','in_progress','resolved','closed']`.
`createTicket` fields: `{ type, issue, username, discordChannel }`. Returns the stored record. Unshifts
newest-first, caps 500. `sessionUser` null → `userId/displayName/avatar = null`, `username` from fields.

- [ ] **Step 1 — failing test:** `lib/tickets.test.js` covering: create returns record with
  `status:'new'`, `id`, timestamps; anonymous (null user) → `userId:null`; logged-in snapshots
  id/displayName/avatar; `listTickets` newest-first; 500-cap keeps newest; `validateUpdate` rejects
  bad status + over-long notes, accepts good; `setDiscordMessage` attaches ids without changing
  status/updatedAt. Use a null pgPool (file fallback) — point `FILE` at a temp path via a fresh
  `require` after setting no PG, or accept the module writes `tickets.json` in cwd and clean it up.
  (Mirror how `cardRequests` is exercised; keep pgPool null so it's file/in-memory only.)
- [ ] **Step 2 — run, expect FAIL** (module missing): `node --test lib/tickets.test.js`.
- [ ] **Step 3 — implement `lib/tickets.js`** as a near-verbatim clone of `lib/cardRequests.js` with:
  hunts_kv key `'tickets'`, `FILE = tickets.json`, `MAX_TICKETS = 500`, `MAX_ISSUE = 5000`,
  `MAX_NOTES = 2000`, `STATUSES` as above, id prefix `tk_`. `createTicket(fields, sessionUser)`
  builds `{ id, createdAt, updatedAt, status:'new', type, issue: String(fields.issue), username,
  userId: sessionUser? String(sessionUser.id):null, displayName: sessionUser? ...:null, avatar:
  sessionUser?.avatar||null, discordChannel: fields.discordChannel, adminNotes:'' }`. `updateTicket`
  patches `status`/`adminNotes` only. Drop card-specific fields (idea/cardName/refLinks/rainbet/
  openCountFor/validateInput/cleanLinks).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat: add tickets persistence store (lib/tickets.js)`.

## Task 2: `routes/adminTickets.routes.js` + tests

**Files:** Create `routes/adminTickets.routes.js`, `routes/adminTickets.routes.test.js`.

**Interfaces — Consumes:** `lib/tickets` (Task 1), `getPlatformBotToken`, `requireAuth`,
`requirePlatformAdmin`. **Produces:** a router with `GET/PUT/DELETE /api/admin/tickets(/:id)`.

- [ ] **Step 1 — failing test:** stub `requireAuth`/`requirePlatformAdmin` as pass-through (and a
  403 variant), inject a fake `tickets` object; assert GET returns the list, PUT calls
  `updateTicket` + (with a stubbed `global.fetch`) fires exactly one Discord PATCH when the record
  has `discordMessageId`/`discordChannelId`, PUT with bad status → 400, DELETE missing → 404.
  Mirror the fetch-stub pattern in `misc.routes.test.js`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** as a clone of the admin half of `cardRequests.routes.js`: `PHASE_META`
  (`new 🆕 #a78bfa`, `in_progress 🔨 #22d3ee`, `resolved ✅ #4ade80`, `closed 🚫 #ff6b6b`),
  `buildTicketEmbed(t)` (title `${phase.emoji} ${typeIcon} ${t.type}` where typeIcon = 💡 for
  Feature Request else 🎫; description = issue; From field = displayName/username + userId; footer
  `CommunityHunts — Tickets`), GET/PUT/DELETE handlers. PUT responds first, then best-effort PATCH.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** `feat: admin tickets router (list/update/delete + phase embed)`.

## Task 3: persist + best-effort in `POST /api/tickets`

**Files:** Modify `routes/misc.routes.js`, `routes/misc.routes.test.js`.

**Interfaces — Consumes:** `tickets` added to `miscRoutes(deps)` destructure.

- [ ] **Step 1 — extend failing tests** in `misc.routes.test.js`: inject a fake `tickets` (records
  `createTicket`/`setDiscordMessage` calls). Assert: (a) a Bug submit calls `createTicket` with
  `type:'Bug'`, `discordChannel:'tickets'` and returns 200 `{ok:true, discord:'posted'}` +
  captures message id; (b) **best-effort** — when `global.fetch` resolves `{ok:false,status:401}`,
  the response is still 200 with `discord:'failed'` and the ticket was still created; (c) logged-out
  submit passes `null` user. Keep the existing platform-token regression guard.
- [ ] **Step 2 — run, expect FAIL** (endpoint still 500s on Discord fail / doesn't persist):
  `node --test routes/misc.routes.test.js`.
- [ ] **Step 3 — implement:** destructure `tickets` from deps. After throttle+channel resolution,
  `const t = tickets.createTicket({ type: kind, issue, username, discordChannel: dest }, req.user || null);`
  Wrap the Discord POST in best-effort: on `!r.ok` log + set `discord='failed'` (do NOT return 500);
  on success capture `msg.id` → `tickets.setDiscordMessage(t.id, {...})`, `discord='posted'`; if no
  token/channel → `discord='skipped'`. Always `res.json({ ok:true, id:t.id, discord })`. Keep the
  `!botToken`/`!channelId` early paths as `skipped` rather than 500 (still store the ticket).
- [ ] **Step 4 — run, expect PASS** (both new + existing tests).
- [ ] **Step 5 — commit** `feat: persist tickets + best-effort Discord (no 500 on failure)`.

## Task 4: `server.js` wiring

**Files:** Modify `server.js`, `.gitignore`.

- [ ] **Step 1 — implement:** near the cardRequests block (~L380), add
  `const tickets = require('./lib/tickets'); tickets.initTickets({ pgPool }).catch(e => console.error('[tickets] init error:', e.message));`
  Add `tickets` to the `misc.routes` mount deps (L538). Add mount:
  `app.use(require('./routes/adminTickets.routes')({ requireAuth, requirePlatformAdmin, tickets, getPlatformBotToken: tenants.getPlatformBotToken }));`
  Add `tickets.json` to `.gitignore`.
- [ ] **Step 2 — boot check:** start the server locally with dummy Discord creds (see backend
  local-dev gotchas) and confirm it boots + `GET /api/health` 200 and `GET /api/admin/tickets`
  requires auth. Then `node --test lib/*.test.js routes/*.test.js` all green.
- [ ] **Step 3 — commit** `feat: wire tickets store + admin router in server.js`.
- [ ] **Step 4 — push branch, open PR** (base main, RandyCabbages). Do NOT self-merge.

## Task 5: frontend adminApi

**Files:** Modify `src/admin/adminApi.js`.

- [ ] Add after the Shop Requests block:
  `export const getTickets = () => apiFetch('/api/admin/tickets');`
  `export const updateTicket = (id, patch) => apiFetch(\`/api/admin/tickets/${encodeURIComponent(id)}\`, { method:'PUT', body: JSON.stringify(patch) });`
  `export const deleteTicket = (id) => apiFetch(\`/api/admin/tickets/${encodeURIComponent(id)}\`, { method:'DELETE' });`
- [ ] Commit (folded into Task 6 build-verify).

## Task 6: `src/admin/AdminTickets.js`

**Files:** Create `src/admin/AdminTickets.js`.

- [ ] Clone `AdminShopRequests.js`. `STATUS_META = { new:{label:'New',color:'#a78bfa'},
  in_progress:{label:'In progress',color:'#22d3ee'}, resolved:{label:'Resolved',color:'#4ade80'},
  closed:{label:'Closed',color:'#ff6b6b'} }`. Add a type-filter chip row (All/Bug/Feature Request/
  Other) storing `filter` state and filtering `rows` by `r.type` (All = no filter). Card shows a
  `type` badge (💡 Feature Request / 🎫 Bug / Other), the `issue` body (read-only), submitter identity
  (avatar+displayName+userId, or "Anonymous" when `userId` null), created date, status `<select>`,
  adminNotes textarea+Save, Delete. `useTheme()`, gated `user?.isPlatformAdmin`. Import
  `getTickets/updateTicket/deleteTicket`.

## Task 7: nav tab + routes + modal copy

**Files:** Modify `src/admin/AdminLayout.js`, `src/App.js`, `src/pages/hub/TicketModal.js`.

- [ ] `AdminLayout.js` — add to `tabs` after Shop Requests:
  `{ to: \`${base}/tickets\`, label: 'Tickets', platformOnly: true }`.
- [ ] `App.js` — `import AdminTickets from './admin/AdminTickets';`; add
  `<Route path="tickets" element={<AdminTickets />} />` under BOTH admin `<Route>` groups
  (after the `shop-requests` route at L184 and L220).
- [ ] `TicketModal.js` — no payload change; leave the alert (now a genuine network/server failure
  path). Optional: change copy to `'Could not reach the server — please try again'`.
- [ ] **Build:** `CI=true npm run build` → "Compiled successfully".
- [ ] **Commit** `feat: admin tickets panel + tab + routes`.
- [ ] **Push branch, open PR** (base main, GooferG). Do NOT self-merge; test on Vercel preview.

---

## Self-Review

- Spec coverage: persistence (T1), admin CRUD + live embed (T2), best-effort persist submit (T3),
  wiring (T4), admin UI/api/nav/routes (T5-7). All spec sections mapped.
- Types consistent: `STATUSES`/`STATUS_META`/`PHASE_META` share the 4 keys across BE+FE.
- No placeholders — each task has concrete code direction + exact test targets.
