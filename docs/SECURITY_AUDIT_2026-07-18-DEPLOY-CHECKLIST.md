# Security Audit 2026-07-18 — Deploy Checklist (out-of-band + comms)

Companion to `SECURITY_AUDIT_2026-07-18-REMEDIATION.md`. The code fixes land via the
batched backend push + frontend branch. **These items are NOT in any diff** — they're
manual actions that get lost if not tracked here. Check them off during the deploy window.

## Deploy sequence

- [ ] `git pull --ff-only` on backend `main`; audit the diff; stage only intended files (never `git add -A`).
- [ ] **Batch ALL backend P0 fixes into one push** (#2, #5, frontend-#1 backend half, #3-partial). One push = one restart = one mass-logout.
- [ ] Confirm Railway revision is live before touching frontend.
- [ ] Frontend #1 UI half (if any): branch → Vercel preview → `CI=true npm run build` = "Compiled successfully" → verify preview → merge.

## Out-of-band secret actions (code alone does NOT fix)

- [ ] **Rotate Bean's `DISCORD_BOT_TOKEN`** (finding #5). Token slices are already in shipped Railway logs; deleting the log line does not un-leak them. Rotate in Discord Developer Portal → update Railway env → do it in the SAME deploy window (restart already logs everyone out).
- [ ] **`DISCORD_CLIENT_SECRET` in `communityhunts-frontend/.env`** (frontend #3). Gitignored + not bundled (not `REACT_APP_`), so not browser-leaking — but a backend secret in the FE tree. Delete it from that file (belongs only in Railway). If any doubt it was committed/shared, rotate it too (update Railway + re-test OAuth login).

## Post-deploy verification (production)

- [ ] Login works — Discord sign-in, `/auth/me` returns correct admin flags (catches a bad OAuth-secret rotation immediately).
- [ ] Discord integrations — trigger import-calls + parse-winners on Bean's tenant; slots/winners still return (validates the #5 token rotation; a 401 = token not updated correctly).
- [ ] Exclusive cards (frontend #1):
  - [ ] Owner of an exclusive card can still equip it.
  - [ ] Non-owner `PUT /api/settings {cosmetics:{card:'card_tylerrr'}}` is REJECTED server-side (the exploit closing).
  - [ ] Note: already-equipped unentitled cards keep rendering (gate blocks new equips, does not un-equip). Manual data cleanup is a separate task if wanted.
- [ ] Admin user view (backend #3-partial) — a Bean mod opening `/api/admin/users/:userId` for an anonymous user sees rainbet/twitch handles REDACTED.

## Proactive user comms (finding #2 behavior change)

- [ ] Heads-up to Bean's mods before/at deploy: *"If a returning caller can't add calls after today's update, have them hit Request Calls and approve them once — it's a one-time re-link."*
  - Why: #2 removed display-name equity matching. Members who only ever matched by name (never ID-linked, never went through request-calls) lose auto call-add until an owner grants them once via the existing flow. Not a regression — the implicit trust being closed — but user-visible.
