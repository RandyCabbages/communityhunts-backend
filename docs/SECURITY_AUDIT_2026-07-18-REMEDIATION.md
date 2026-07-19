# Security Audit — Remediation Plan (2026-07-18)

Consolidates the two `security-ai-generated-code-auditor` reports + a follow-up verification pass.

**Sources**
- Backend: `communityhunts-backend/docs/SECURITY_AUDIT_2026-07-18.md` (7 findings)
- Frontend: `communityhunts-frontend/docs/SECURITY_AUDIT_2026-07-18.md` (3 findings)

**No code changed yet.** This is the fix plan; execute on branches (frontend) / batched pushes (backend).

---

## Reframe: exploitable TODAY vs latent-until-`MULTI_TENANT`

The reports rate by CWE severity. For **urgency**, the deciding axis is the `MULTI_TENANT` flag (currently OFF — single-tenant Bean):

- **Cross-tenant findings (backend #1, #3-full, #4) are NOT reachable today** — there is only one tenant. They become live the moment `MULTI_TENANT=true`. **Fix them before flipping the flag.**
- **Exploitable NOW, regardless of the flag:** backend #2, backend #5, frontend #1 (verified), frontend #3 (hygiene), and the redaction half of backend #3.

---

## Verification updates (this session)

**Frontend #1 — CONFIRMED REAL (upgraded Low → Medium).**
Backend `PUT /api/settings` *does* re-check tier + mod-only (`routes/settings.routes.js:86-113`). **But** `isItemAccessible` (`routes/cosmetics.routes.js:49-57`) takes no `userId` and never enforces `exclusiveUserId`, and every exclusive/commissioned card is tier `'free'` in `ITEM_TIERS` (`cosmetics.routes.js:11-15`: `card_bean`, `card_goofer`, `card_cabbage`, `card_tylerrr`, `card_rasseewz`, `card_sverrir`, `card_folo`, `card_cook`, `card_god`, …).
→ A signed-in non-owner can `PUT /api/settings {cosmetics:{card:'card_tylerrr'}}` and equip any exclusive/paid-commission card for free; it renders to everyone on their equity row. Defeats the **paid** exclusive-card product, so it's revenue/exclusivity, not just vanity.
**Fix:** add an `EXCLUSIVE_ITEMS` map (`itemId → allowed userId`) to `cosmetics.routes.js`, mirroring the frontend catalog's `exclusiveUserId`. In the settings equip loop, reject an exclusive item unless `req.user.id` matches, it's admin-granted (in `owned`), or `priv`. Mirror the existing `MOD_ONLY_ITEMS` pattern. Respect the ITEM_TIERS↔catalog sync rule + **backend-first deploy**.

---

## Priority / fix order

### P0 — exploitable in current prod (do first)

1. **Backend #2 (MED)** — display-name equity authz + identity claim on GET. Gate `isEquityMember` on `discordId`/`callsPermissions` only; drop name-variant + `startsWith`; remove the auto-link write in `GET /api/hunts/:userId`.
   - `lib/auth.js:133-169`, `routes/hunts.routes.js:74-100`
2. **Backend #5 (MED)** — stop logging Discord bot-token slices; log a boolean/length only. Then **rotate** any tenant bot token already in shipped logs (out-of-band).
   - `routes/integrations.routes.js:82`, `lib/integrations.js:185`, `server.js:90,124`
3. **Frontend #1 (MED, verified)** — add backend `exclusiveUserId` enforcement (see verification note).
   - `routes/cosmetics.routes.js`, `routes/settings.routes.js:86-113`
4. **Frontend #3 (hygiene)** — rotate-or-delete the real `DISCORD_CLIENT_SECRET` in `communityhunts-frontend/.env`. Not bundled (gitignored, not `REACT_APP_`), but a backend secret in the FE tree. 2-min decision.
5. **Backend #3 (partial)** — apply the `anonymous` redaction to `GET /api/admin/users/:userId` now (a Bean mod can already read anonymous users' rainbet/twitch handles).
   - `routes/settings.routes.js:237-347`

### P1 — before flipping `MULTI_TENANT=true` (latent authz)

6. **Backend #1 (HIGH)** — in `canEditHunt` and the `reqIsAdmin` branches, require target hunt `tenantId === req.tenant.id` (mirror `inTenant()` already used throughout `admin.routes.js`). Also closes the known "Admin canEditHunt Bug".
   - `lib/auth.js:120-132`; `routes/calls.routes.js:66,69,84,92,151,159`; `routes/hunts.routes.js:359,375`; `routes/share.routes.js:15`
7. **Backend #4 (MED)** — add `inTenant(hunt, req.tenant?.id)` guard to the live single-hunt route; 404 otherwise (mirror the archived sibling at `:63`).
   - `routes/hunts.routes.js:67-114`
8. **Backend #3 (full)** — scope `GET /api/admin/users*` to the caller's tenant (`community_members`) and/or `requirePlatformAdmin`.

### P2 — hardening (whenever)

9. **Backend #6 (LOW)** — CORS: reflect `chrome-`/`moz-extension://` origins with `credentials:false` (the extension authenticates by HMAC Bearer, not cookies), or pin known extension IDs. `server.js:26-35,167`
10. **Backend #7 (LOW)** — ensure `SESSION_SECRET` is set in Railway (silent per-boot random today → mass logout each deploy + no Bearer fallback across restarts); add rate limits to `/api/leaderboard`, `/api/discord/import-calls`, `/api/discord/parse-winners`.
11. **Frontend #2 (LOW)** — add a `sandbox` attr to the replay iframe, or allowlist known video hosts. `safeReplayHref` validates scheme only.
    - `src/pages/hub/ReplayModal.js:65`, `src/hunt/huntMath.js:43`

---

## Passed clean (no action)

- **Backend:** no hardcoded secrets; Stripe webhook signature verified (`express.raw` + `constructEvent` + replay guard); Bearer HMAC-SHA256 sound (timingSafeEqual + expiry); public Developer API tiers enforced per-route + PII stripped; SQL fully parameterized; tenant role checks are ID-based.
- **Frontend:** no bundled secrets beyond the public API base; all render sinks escaped/guarded (no XSS, no `dangerouslySetInnerHTML`/`eval`); admin, tenant, purchase, and feature/tier gates are all backend-enforced (client gates are UI-only).

---

## Deploy notes

- **Backend-first** for the cosmetics fix (ITEM_TIERS/EXCLUSIVE ↔ catalog sync — same rule as shipping a new card).
- Each backend push **restarts prod (mass logout)** — batch the backend fixes.
- Frontend: branch + Vercel preview; `CI=true npm run build` must print "Compiled successfully"; **no `Co-Authored-By` trailers**.
- Secret/token rotations (#5, FE #3) are **out-of-band actions, not code** — track separately so they don't get lost after the code lands.
