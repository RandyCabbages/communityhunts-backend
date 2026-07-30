// The Discord bot's endpoints, on the public API: which accounts exist, open a run, merge the
// giveaway's winners onto its equity sheet, cancel a run, and file a winner's slot calls.
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
const { CATEGORIES, isCategory, keyForCategory, sharedRunHasWork, encodeRunKey, decodeRunKey,
        cleanMembers, mergeEquity, cleanSlots, findEquityRow } = require('../lib/discordHunts');
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
    normalizeSlot, nameOf, activityFeed,
  } = deps;
  const router = express.Router();

  // The same implementation the session-authed call routes use, so a bot-filed call meets the
  // identical duplicate check, rolling gate and per-person limit.
  const { addCallToHunt } = require('../lib/huntCalls')({
    normalizeSlot, nameOf, emitHuntUpdate, activityFeed,
  });

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
        // `key` is a RUN key — the hunt key with this run's id on it. Hand it back on the equity
        // write and the stale-run guard there works with nothing else stored anywhere: the caller
        // keeps one opaque string, not two fields it has to plumb through a third service.
        // `huntId` is also returned on its own, for a caller that would rather hold them apart.
        res.status(201).json({
          key: encodeRunKey(key, hunt.huntId),
          huntId: hunt.huntId,
          category,
          shareUrl: shareLinks.shareUrl(tid, token),
        });
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
        // The run key the giveaway opened against, as `open` handed it over. A bare hunt key is
        // still accepted — it just carries no run to check, so it only gets the weaker guard.
        const claimed = decodeRunKey(body.key);
        if (body.key && claimed.key !== key) {
          return fail(res, 409, 'stale_key', 'That hunt key is not this category\'s current hunt');
        }

        const hunt = hunts[key];
        if (!hunt) return fail(res, 404, 'no_hunt', 'That hunt has not been opened');
        // The only check that can see a RESET. The hunt key is the same string for every run of a
        // category, so comparing it cannot; the run id can. Without this, winners from a giveaway
        // whose hunt a mod restarted mid-stream land on the new run's sheet as if they were its own.
        const claimedRun = claimed.huntId || body.huntId;
        if (claimedRun && claimedRun !== hunt.huntId) {
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
        res.json({ key: encodeRunKey(key, hunt.huntId), huntId: hunt.huntId,
                   added, updated, rejectedIdentities: vetted.rejected.length });
      } catch (e) { next(e); }
    });

  // Throw the run away, because the giveaway that made it was cancelled.
  //
  // The ONLY destructive endpoint here, and the only one that archives nothing. A cancelled
  // giveaway "does need to cancel and delete the hunt, no saving of it" — leaving its equity
  // sheet in the archive would put a hunt that never happened into the ledger and the hunt
  // history, where it reads as real.
  //
  // The run is REPLACED with a fresh empty one rather than the key being deleted outright. The
  // shared hunt is a permanent fixture: it has a page, an overlay pointed at it and a stable share
  // link, so removing the object mid-stream would break surfaces that have nothing to do with the
  // giveaway. A new empty run with a new id is the same thing from every angle that matters — the
  // cancelled run is gone, and nothing was kept.
  router.post('/api/public/v1/hunts/shared/cancel',
    requireApiFeature('discord_hunts'), requireApiScope('write'), writeRateLimit, (req, res, next) => {
      try {
        const tid = req.apiTenantId;
        const body = req.body || {};

        // Which hunt this key is for is derived from the key itself, not taken from the caller:
        // a cancel that trusted a `category` field alongside a mismatched key could delete the
        // wrong one of the two.
        const claimed = decodeRunKey(body.key);
        const category = CATEGORIES.find((c) => keyFor(c, tid) === claimed.key);
        if (!category) {
          return fail(res, 400, 'invalid_key',
            'key must be a run key for one of this tenant\'s shared hunts');
        }

        const key = claimed.key;
        const hunt = hunts[key];
        if (!hunt) return fail(res, 404, 'no_hunt', 'That hunt has not been opened');

        // Refuses unless this is still the same run. Cancelling an old giveaway must never reach
        // through and delete the run a mod started after it — which is exactly what a bare hunt
        // key could not prevent, since it is the same string for every run of a category.
        if (!claimed.huntId || claimed.huntId !== hunt.huntId) {
          return fail(res, 409, 'stale_run', 'That run has ended — the hunt has been reset since');
        }

        // Bonuses mean somebody is mid-hunt on stream. Cancelling the giveaway that seeded the
        // sheet is not licence to delete an actual hunt, and unlike everything else here that
        // loss would be unrecoverable, because this is the one path that does not archive.
        if (Array.isArray(hunt.bonuses) && hunt.bonuses.length > 0) {
          return fail(res, 409, 'hunt_in_progress',
            'That hunt has bonuses on it. End or reset it on the site instead.');
        }

        const had = Array.isArray(hunt.equity) ? hunt.equity.length : 0;
        hunts[key] = category === 'affiliate'
          ? sharedHunts.emptyAffiliateHunt(tid)
          : sharedHunts.emptyVipHunt(tid);
        persistHunts();
        emitHuntUpdate(key);

        auditLog.record({
          category: 'api', action: 'hunt.shared.cancel',
          actorId: `apikey:${tid}`, actorName: 'Discord bot', tenantId: tid, targetId: key,
          summary: `Discord bot cancelled the ${category} hunt "${hunt.title}" (${had} equity ${had === 1 ? 'row' : 'rows'} discarded, nothing archived)`,
          detail: { category, huntId: hunt.huntId, equityDiscarded: had },
          ip: req.ip,
        });

        res.set('Cache-Control', 'no-store');
        res.json({ cancelled: true, category, huntId: hunt.huntId, equityDiscarded: had });
      } catch (e) { next(e); }
    });

  // A checked-in winner's slot calls, filed from Discord.
  //
  // **Authorised by the equity sheet, not by the key.** The key says which community this is; it
  // must not also mean "may call for anybody". The caller has to already hold a row on this run,
  // which is the same question routes/calls.routes.js asks through isEquityMember. Unlinked
  // winners still work — the equity merge put them on the sheet by name at check-in, and that is
  // deliberately the ONLY route by which they can call at all: a shared run has
  // `publicCalls: false`, so the website's own public-call link is closed to them.
  //
  // Every slot is answered on its own. The bot writes one reply out of these, and someone who
  // typed five slots needs to know which of them landed rather than a single yes or no.
  router.post('/api/public/v1/hunts/shared/calls',
    requireApiFeature('discord_hunts'), requireApiScope('write'), writeRateLimit, (req, res, next) => {
      try {
        const tid = req.apiTenantId;
        const body = req.body || {};
        if (!isCategory(body.category)) {
          return fail(res, 400, 'invalid_category', 'category must be one of: affiliate, vip');
        }

        const key = keyFor(body.category, tid);
        const claimed = decodeRunKey(body.key);
        if (body.key && claimed.key !== key) {
          return fail(res, 409, 'stale_key', 'That hunt key is not this category\'s current hunt');
        }

        const hunt = hunts[key];
        if (!hunt) return fail(res, 404, 'no_hunt', 'That hunt has not been opened');
        // The same three guards the equity write applies, for the same reason: a call must not land
        // on a run a mod restarted underneath the giveaway, nor on one already in the archive.
        const claimedRun = claimed.huntId || body.huntId;
        if (claimedRun && claimedRun !== hunt.huntId) {
          return fail(res, 409, 'stale_run', 'That run has ended — the hunt has been reset since');
        }
        if (hunt.archivedAt) return fail(res, 409, 'run_ended', 'That run has ended');

        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
        const asserted = isRealDiscordId(body.discordId) ? String(body.discordId) : null;
        const row = findEquityRow(hunt.equity, { discordId: asserted, name });
        if (!row) {
          return fail(res, 403, 'not_on_hunt', 'You are not on that hunt\'s equity sheet');
        }

        const slots = cleanSlots(body.slots);
        if (slots.length === 0) {
          return fail(res, 400, 'invalid_slots', 'slots must be a non-empty array of slot names');
        }

        // Built from the MATCHED ROW, never from the request. The row's discordId was vetted when
        // it was written; taking the body's would let a name match staple a stranger's id onto
        // somebody else's call and roll it into their caller stats. This is the same guarantee
        // vetCallerIdentity gives on the editor save path, made structural instead of checked.
        const user = { id: row.discordId ? String(row.discordId) : undefined,
                       displayName: row.name };

        const results = slots.map((slot) => {
          const outcome = addCallToHunt(hunt, user, slot, { source: 'discord' });
          return outcome.ok
            ? { slot, ok: true }
            : { slot, ok: false, reason: outcome.code, message: outcome.error };
        });

        const added = results.filter((r) => r.ok).length;

        // Only when something actually landed. A caller re-submitting the same five slots is a
        // no-op, and an audit line per no-op buries the ones that mean something — the same reason
        // the equity write compares content before recording.
        if (added > 0) {
          persistHunts();
          auditLog.record({
            category: 'api', action: 'hunt.shared.calls',
            actorId: `apikey:${tid}`, actorName: 'Discord bot', tenantId: tid, targetId: key,
            summary: `Discord bot filed ${added} slot ${added === 1 ? 'call' : 'calls'} for ${row.name} on the ${body.category} hunt`,
            detail: { category: body.category, huntId: hunt.huntId, added,
                      refused: results.length - added },
            ip: req.ip,
          });
        }

        res.set('Cache-Control', 'no-store');
        res.json({ key: encodeRunKey(key, hunt.huntId), huntId: hunt.huntId, added, results });
      } catch (e) { next(e); }
    });

  return router;
};
