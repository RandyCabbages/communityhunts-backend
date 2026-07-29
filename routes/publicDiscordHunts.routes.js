// The Discord bot's three endpoints, on the public API.
//
// Mounted INSIDE routes/public.routes.js so it inherits that router's CORS, `Vary: Authorization`,
// `ipFloor → requireApiKey → rateLimit` chain and error envelope — one chain, not a second copy
// that can drift out of step with it. Its own file because this is a distinct feature behind a
// distinct plan gate (`discord_hunts`, Partner-only), not more of the Developer API.
//
// **The key is the tenant, and the target is that tenant's own shared hunt.** Nothing here acts as
// a user, so there is no impersonation surface: the alternative design — minting a session token
// per mod — would have handed the bot a secret that can sign a token for ANY CH user, admins
// included.
//
// Response shapes are top-level (`{ key, shareUrl }`), not the Developer API's `{ data }` envelope.
// Deliberate: these answer a fixed bot contract (discordBot/src/communityHunts.ts + API.md) rather
// than serving serialized hunt resources, and the bot is already written against them.

const express = require('express');
const { isRealDiscordId } = require('../lib/userIds');
const { isCategory, keyForCategory, sharedRunHasWork, cleanMembers, mergeEquity } = require('../lib/discordHunts');
const { vetEquityIdentity } = require('../lib/identityWrites');

// Bounds the per-request work: each id is a lookup, and the bot only ever asks about the winners
// of one giveaway. A wider list is a mistake or a crawl, and either way it should be told so.
const MAX_KNOWN_IDS = 100;

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

module.exports = function publicDiscordHuntsRoutes(deps) {
  const {
    requireApiFeature, requireApiScope, writeRateLimit,
    hunts, affiliateHuntKey, vipHuntKey, sharedHunts, shareLinks,
    archiveHunt, persistHunts, emitHuntUpdate, uid, isKnownAccount, auditLog,
  } = deps;
  const router = express.Router();

  const keyFor = (category, tenantId) =>
    keyForCategory(category, tenantId, { affiliateHuntKey, vipHuntKey });

  // Which of these ids already have a CommunityHunts account.
  //
  // Ids ONLY — no names, no avatars, nothing about anyone it does not know, and nothing about ids
  // that were not asked for. It answers about people the caller already holds ids for, which is the
  // narrowest form this question has. Read scope (the default) is enough: it writes nothing.
  //
  // Every lookup fails CLOSED. An unreachable database returns "not known", so the bot writes a
  // name-only equity row — recoverable on the next sweep — rather than claiming an identity.
  router.get('/api/public/v1/accounts/known', requireApiFeature('discord_hunts'), async (req, res, next) => {
    try {
      const asked = String(req.query.discordIds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (asked.length > MAX_KNOWN_IDS) {
        return fail(res, 400, 'too_many_ids', `At most ${MAX_KNOWN_IDS} ids per request`);
      }

      // Shape-checked before anything is looked up: a row id or a `manual:<name>` placeholder is
      // not a Discord id and must not become a database round trip.
      const ids = [...new Set(asked.filter(isRealDiscordId))];
      const known = [];
      for (const id of ids) {
        let hit = false;
        try { hit = !!(await isKnownAccount(id)); } catch { hit = false; }
        if (hit) known.push(id);
      }

      res.set('Cache-Control', 'no-store');
      res.json({ known });
    } catch (e) { next(e); }
  });

  // Open (reset to a fresh run) the tenant's shared hunt for this category, and say where to send
  // people. Idempotent in the way that matters: the share token is stable per owner, so the URL
  // survives across runs and previously-shared links keep working.
  router.post('/api/public/v1/hunts/shared/open',
    requireApiFeature('discord_hunts'), requireApiScope('write'), writeRateLimit, (req, res, next) => {
      try {
        const tid = req.apiTenantId;
        const category = req.body && req.body.category;
        if (!isCategory(category)) {
          return fail(res, 400, 'invalid_category', 'category must be one of: affiliate, vip');
        }
        const key = keyFor(category, tid);
        const old = hunts[key];

        // REFUSES rather than resets. A run with a mod's work in it is not ours to discard
        // mid-stream, and `reset` only archives a run that has BONUSES — a set-up-but-not-started
        // sheet is dropped outright. The bot surfaces this to the mod, who ends or resets it
        // themselves; the Discord giveaway still runs either way.
        if (sharedRunHasWork(old)) {
          return fail(res, 409, 'hunt_in_progress',
            'That hunt already has a run in progress. End or reset it first.');
        }

        // Mirrors the mod-console reset: an ended run that still holds bonuses is (re-)archived
        // before it is replaced. archiveHunt upserts on the snapshot's own archiveId, so doing it
        // again after /end is a no-op rather than a duplicate.
        if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
          if (!old.archivedAt) old.archivedAt = new Date().toISOString();
          archiveHunt(old);
        }

        const title = req.body && req.body.title;
        hunts[key] = category === 'affiliate'
          ? sharedHunts.emptyAffiliateHunt(tid, title)
          : sharedHunts.emptyVipHunt(tid, title);
        persistHunts();
        emitHuntUpdate(key);

        const token = shareLinks.ensureShareToken(key);
        const hunt = hunts[key];

        auditLog.record({
          category: 'api', action: 'hunt.shared.open',
          actorId: `apikey:${tid}`, actorName: 'Discord bot', tenantId: tid, targetId: key,
          summary: `Discord bot opened the ${category} hunt "${hunt.title}"`,
          detail: { category, huntId: hunt.huntId },
          ip: req.ip,
        });

        res.set('Cache-Control', 'no-store');
        // `huntId` identifies THIS run, where `key` is the same for every run of the category.
        // A caller that stores it gets a real stale-run guard on the equity write below.
        res.status(201).json({ key, huntId: hunt.huntId, category, shareUrl: shareLinks.shareUrl(tid, token) });
      } catch (e) { next(e); }
    });

  // Fold the giveaway's winners onto that hunt's equity sheet.
  //
  // A MERGE, never a replace. The shared-hunt PUT replaces whichever arrays it is given, and
  // `preserveRowIdentity` only stops an ABSENT field clearing a known one — it does not stop a
  // short array deleting rows. A bot sending just its own winners through that path would delete
  // everyone a mod had added by hand, which is the vault-deletion failure class. Merging server-
  // side also means the bot never does read-modify-write against a sheet several mods edit live.
  router.post('/api/public/v1/hunts/shared/equity',
    requireApiFeature('discord_hunts'), requireApiScope('write'), writeRateLimit, async (req, res, next) => {
      try {
        const tid = req.apiTenantId;
        const body = req.body || {};
        if (!isCategory(body.category)) {
          return fail(res, 400, 'invalid_category', 'category must be one of: affiliate, vip');
        }
        if (!Array.isArray(body.members)) {
          return fail(res, 400, 'invalid_members', 'members must be an array');
        }

        const key = keyFor(body.category, tid);
        // The key the giveaway opened against. A mismatch means the caller is writing against a
        // hunt it did not open — refuse rather than land somebody's winners on the wrong sheet.
        if (body.key && body.key !== key) {
          return fail(res, 409, 'stale_key', 'That hunt key is not this category\'s current hunt');
        }

        const hunt = hunts[key];
        if (!hunt) return fail(res, 404, 'no_hunt', 'That hunt has not been opened');
        // Optional, and the only check that can actually see a RESET: `key` is stable across runs,
        // so it cannot. A caller that stored the `huntId` from open gets its winners refused rather
        // than merged into whatever run a mod has started since.
        if (body.huntId && body.huntId !== hunt.huntId) {
          return fail(res, 409, 'stale_run', 'That run has ended — the hunt has been reset since');
        }
        // A run a mod has ENDED is already in the archive as its own snapshot. Merging into the
        // live object now would leave the two disagreeing about who was on the sheet, with the
        // archived copy — the one the ledger and hunt history read — missing the winners.
        if (hunt.archivedAt) {
          return fail(res, 409, 'run_ended', 'That run has ended');
        }

        const members = cleanMembers(body.members);
        const before = Array.isArray(hunt.equity) ? hunt.equity : [];
        const beforeJson = JSON.stringify(before);   // mergeEquity copies rather than mutating
        const { rows, added, updated } = mergeEquity(before, members, { uid });

        // Client-asserted discordIds are vetted against real accounts and STRIPPED when they fail.
        // An API key is a less trusted caller than a signed-in host, so this is not optional —
        // skipping it would reopen, from a machine endpoint at volume, exactly the hole backend
        // PR #88 closed. vetEquityIdentity fails CLOSED when the predicate is missing, so a wiring
        // mistake rejects identities rather than admitting them.
        const vetted = await vetEquityIdentity(before, rows, { isKnownAccount });
        hunt.equity = vetted.rows;
        hunt.updatedAt = new Date().toISOString();
        persistHunts();
        emitHuntUpdate(key);

        // Only when the sheet actually changed. The bot re-sends the same winners every sweep, and
        // a re-send counts as `updated` (the row is matched and re-stamped) even when every value
        // is identical — so gating on the merge's counters would write an audit line per sweep, all
        // night, burying the ones that mean something. Compared by CONTENT, the same way
        // lib/persistence.js decides a row is worth writing.
        if (beforeJson !== JSON.stringify(hunt.equity)) {
          auditLog.record({
            category: 'api', action: 'hunt.shared.equity',
            actorId: `apikey:${tid}`, actorName: 'Discord bot', tenantId: tid, targetId: key,
            summary: `Discord bot merged ${added} new and ${updated} updated equity ${added + updated === 1 ? 'row' : 'rows'} onto the ${body.category} hunt`,
            detail: { category: body.category, huntId: hunt.huntId, added, updated,
                      rejectedIdentities: vetted.rejected.length },
            ip: req.ip,
          });
        }

        res.set('Cache-Control', 'no-store');
        // Surfaced, not silent: a row whose discordId was refused will not roll up into payouts or
        // caller leaderboards, and the caller needs to know that happened.
        res.json({ key, huntId: hunt.huntId, added, updated, rejectedIdentities: vetted.rejected.length });
      } catch (e) { next(e); }
    });

  return router;
};
