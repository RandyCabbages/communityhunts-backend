// Auth + community-membership routes. Thin router; mounted from the server.js composition
// root AFTER the lib deps (settings/memberships/tenants/auth) exist. The Passport Discord
// strategy itself is configured in server.js (passport.use); these routes consume it.
//
//   GET  /auth/discord                 — start Discord OAuth
//   GET  /auth/discord/callback        — OAuth callback (records user, auto-joins, signs token)
//   GET  /auth/logout                  — clear session
//   GET  /auth/me                      — current user + isAdmin/isVipHost/isPlatformAdmin
//   GET  /api/known-users              — equity-name autocomplete list (auth required)
//   GET  /api/my-communities           — tenant slugs the user belongs to
//   POST /api/communities/:slug/join   — join a community
//   POST /api/communities/:slug/leave  — leave a community

const express = require('express');

module.exports = function authRoutes(deps) {
  const {
    passport, FRONTEND_URL, requireAuth,
    reqIsAdmin, reqIsVipHost, reqIsMod, isPlatformAdmin, signToken, guildFlags,
    recordKnownUser, memberships, tenants, pgPool, subscriptions, refreshGuildRoles, featureGrants,
    auditLog, bans, activityFeed,
  } = deps;
  const router = express.Router();

  // Keep the ROLE-derived half of community_members in sync with the user's current role for the
  // tenant they're authenticating through: join if they qualify, evict if we KNOW they don't, and
  // do nothing when their guild roles are undetermined (a transient Discord lookup failure must
  // not churn the table). Replaces the old "auto-join everyone" behavior.
  //
  // Both writes are source-scoped to 'role', and that is load-bearing. Membership is no longer
  // role-only: a user can press Join in Settings, which writes source='self'. This function runs
  // on EVERY login, so an unscoped evict here wiped every deliberate join at the user's next
  // sign-in — the Join button did nothing that lasted (2026-07-25). A 'role' join likewise cannot
  // downgrade a 'self' row (DO NOTHING on conflict), or the next role lapse would evict it.
  function reconcileMembership(req) {
    const u = req.user;
    if (!u || !req.tenant || !req.tenant.id) return;
    const determined = ('isAffiliate' in u) || ('isDiscordVip' in u) || ('isDiscordMod' in u);
    const qualifies =
      reqIsAdmin(req) || reqIsVipHost(req) || reqIsMod(req) ||
      !!u.isAffiliate || !!u.isDiscordVip || !!u.isDiscordMod;
    if (qualifies) {
      memberships.joinCommunity(u.id, req.tenant.id, 'role').catch(() => {});
    } else if (determined) {
      memberships.leaveCommunity(u.id, req.tenant.id, { onlySource: 'role' }).catch(() => {});
    }
    // undetermined & not otherwise-qualified → no-op
  }

  router.get('/auth/discord', (req, res, next) => {
    if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
    passport.authenticate('discord')(req, res, next);
  });
  router.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: `${FRONTEND_URL}/?error=auth` }),
    (req, res) => {
      // Banned users: stop here before issuing a token. Bounce to the frontend with ?banned=1
      // so it shows the ban notice ("tries to get into the hub → popup"). No session token,
      // and every subsequent API call is refused by the global ban gate anyway.
      if (bans && req.user && bans.isBanned(req.user.id)) {
        return res.redirect(`${FRONTEND_URL}/?banned=1`);
      }
      // Record this user as known so they show up in equity-name autocomplete for others
      recordKnownUser(req.user);
      if (req.user) auditLog.record({ category: 'auth', action: 'auth.login',
        actorId: req.user.id, actorName: req.user.displayName,
        tenantId: req.tenant && req.tenant.id, ip: req.ip,
        summary: `${req.user.displayName || req.user.id} logged in` });
      // Admin Mission Control live feed (transient ticker — the auditLog above stays the record).
      if (req.user) activityFeed?.push(req.tenant && req.tenant.id, {
        type: 'login',
        text: `${req.user.displayName || req.user.username} signed in`,
        meta: { userId: String(req.user.id) },
      });
      // Sync membership to their role for the community they signed in through (Bean today; the
      // slug they arrived via later). Guild flags are already on req.user from the passport strategy.
      reconcileMembership(req);
      const userData = Buffer.from(JSON.stringify({
        id: req.user.id, username: req.user.username,
        displayName: req.user.displayName, avatar: req.user.avatar,
        isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isCommunityMod: reqIsMod(req), isPlatformAdmin: isPlatformAdmin(req.user),
        ...guildFlags(req.user),
      })).toString('base64');
      const returnTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      // Signed token — frontend stores this and sends as Bearer in case cookies are blocked
      const token = signToken(req.user);
      const returnParam = returnTo !== '/' ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
      res.redirect(`${FRONTEND_URL}/?auth=${encodeURIComponent(userData)}&t=${encodeURIComponent(token)}${returnParam}`);
    }
  );
  // Capture the actor BEFORE req.logout clears the session.
  router.get('/auth/logout', (req, res) => {
    const u = req.user;
    if (u) auditLog.record({ category: 'auth', action: 'auth.logout',
      actorId: u.id, actorName: u.displayName, tenantId: req.tenant && req.tenant.id, ip: req.ip,
      summary: `${u.displayName || u.id} logged out` });
    req.logout(() => res.redirect(FRONTEND_URL));
  });
  router.get('/auth/me', async (req, res) => {
    if (!req.user) return res.json({ user: null });
    recordKnownUser(req.user);
    const [sub, freshRoles] = await Promise.all([
      subscriptions ? subscriptions.getSubscription(req.user.id) : null,
      refreshGuildRoles ? refreshGuildRoles(req.user.id, req.tenant) : null,
    ]);
    if (freshRoles) {
      Object.assign(req.user, freshRoles);
      req.session.passport && (req.session.passport.user = req.user);
    }
    reconcileMembership(req);
    res.json({ user: { ...req.user, isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isCommunityMod: reqIsMod(req), isPlatformAdmin: isPlatformAdmin(req.user),
      ...guildFlags(req.user),
      subscription: sub || { tier: 'free' },
      featureGrants: featureGrants ? featureGrants.getGrantsForUser(req.user.id) : [] },
      token: signToken(req.user) });
  });

  // Known-users list for equity-name autocomplete — {id, displayName, avatar} for everyone
  // who's logged in, by recency. Auth-gated: logged-in users adding people to a hunt need it;
  // anonymous callers don't, and leaving it public exposed the whole roster + Discord IDs.
  // Synthetic manual: rows are excluded (see lib/userIds.js).
  router.get('/api/known-users', requireAuth, async (req, res) => {
    if (!pgPool) return res.json([]);
    // `?q=` switches from the bootstrap list to a server-side search. The bare list is capped at
    // the 500 most recent logins, which is fine as a mount-time seed (it also feeds role-badge
    // resolution) but silently hides everyone outside that window once a community passes 500
    // sign-ins — and a host who can't find someone in the dropdown types the name instead, which
    // is exactly how a row ends up back in the /admin/identity queue. Escape LIKE wildcards so a
    // literal % or _ in a display name searches as itself.
    const q = String(req.query.q || '').trim().slice(0, 60);
    try {
      // Real Discord logins only. Synthetic `manual:<name>` rows reach known_users via the
      // startup backfill and are indistinguishable from a login once there — they cluttered the
      // equity dropdown with people who never had an account. Filtering here rather than at the
      // call site keeps every consumer of this endpoint honest. Mirrors lib/userIds.isRealDiscordId;
      // the regex is inlined because this runs in Postgres, not Node.
      const r = q
        ? await pgPool.query(
            `SELECT user_id AS id, display_name AS "displayName", avatar
             FROM known_users
             WHERE user_id ~ '^[0-9]{17,20}$'
               AND (display_name ILIKE $1 OR username ILIKE $1)
             ORDER BY last_seen DESC
             LIMIT 20`,
            [`%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`]
          )
        : await pgPool.query(
            `SELECT user_id AS id, display_name AS "displayName", avatar
             FROM known_users
             WHERE user_id ~ '^[0-9]{17,20}$'
             ORDER BY last_seen DESC
             LIMIT 500`
          );
      res.json(r.rows);
    } catch(e) {
      console.error('[known_users] list failed:', e.message);
      res.json([]);
    }
  });

  // ── Community memberships ──────────────────────────────────────────
  // GET /api/my-communities — tenant slugs the logged-in user belongs to.
  router.get('/api/my-communities', requireAuth, async (req, res) => {
    res.json({ communities: await memberships.getUserCommunities(req.user.id) });
  });

  // POST /api/communities/:slug/join — join a community (the slug in the path, validated against tenants).
  router.post('/api/communities/:slug/join', requireAuth, async (req, res) => {
    const t = tenants.getTenantBySlug(String(req.params.slug));
    if (!t) return res.status(404).json({ error: 'Unknown community' });
    await memberships.joinCommunity(req.user.id, t.id);
    res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
  });

  // POST /api/communities/:slug/leave — leave a community.
  router.post('/api/communities/:slug/leave', requireAuth, async (req, res) => {
    const t = tenants.getTenantBySlug(String(req.params.slug));
    if (!t) return res.status(404).json({ error: 'Unknown community' });
    await memberships.leaveCommunity(req.user.id, t.id);
    res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
  });

  return router;
};
