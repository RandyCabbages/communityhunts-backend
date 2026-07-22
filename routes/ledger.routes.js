// Cross-hunt payout ledger.
//   GET   /api/ledger                          — slices for both directions (auth)
//   PATCH /api/ledger/:huntKey/:memberId       — resolve one payout (host/mod only)
//
// The ledger FOLD lives in the frontend (src/hunt/ledgerFormat.js) because owed
// amounts require computeGiftResults, whose only implementation is giftLedger.js.
// Duplicating that vault-aware money math here would create two sources of truth.

const express = require('express');
const { makeLedgerQuery, canResolveHunt } = require('../lib/ledgerQuery');
const { sanitizePayouts } = require('../lib/payouts');

module.exports = ({ pgPool, requireAuth, reqIsMod, archive, persistArchive, huntKey }) => {
  const router = express.Router();
  const q = makeLedgerQuery(pgPool);

  // Cache is per (tenant, user) — the two directions are both caller-scoped.
  const cache = new Map();
  const TTL = 30 * 1000;
  const keyOf = (t, u) => `${t}|${u}`;
  const invalidate = (t, u) => cache.delete(keyOf(t, u));

  router.get('/api/ledger', requireAuth, async (req, res) => {
    const tenantId = req.tenant?.id || 'bean';
    const userId = String(req.user.id);
    const ck = keyOf(tenantId, userId);
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < TTL) return res.json(hit.data);
    try {
      const isMod = !!reqIsMod(req);
      const [owed, received] = await Promise.all([
        q.owed(tenantId, userId, isMod),
        q.received(tenantId, userId),
      ]);
      const data = { owed, received };
      cache.set(ck, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      console.error('[ledger] read failed:', e.message);
      res.status(500).json({ error: 'Failed to load ledger' });
    }
  });

  router.patch('/api/ledger/:huntKey/:memberId', requireAuth, async (req, res) => {
    const tenantId = req.tenant?.id || 'bean';
    const userId = String(req.user.id);
    const { huntKey: key, memberId } = req.params;
    try {
      const row = await q.findRow(tenantId, key);
      if (!row) return res.status(404).json({ error: 'Hunt not found' });
      if (!canResolveHunt({ hostUserId: row.host_user_id, callerId: userId, isMod: !!reqIsMod(req) })) {
        return res.status(403).json({ error: 'Not your hunt' });
      }

      const current = (row.snapshot && row.snapshot.payouts) || {};
      const next = { ...current };
      if (req.body && req.body.status === null) {
        delete next[memberId];                      // Undo → back to Pending
      } else {
        // Route the single record through the shared sanitizer, so the ledger can
        // never write a shape the hunt-side tracker would reject.
        const clean = sanitizePayouts({
          [memberId]: {
            status: req.body?.status,
            amount: req.body?.amount,
            at: Date.now(),
            by: userId,
            note: req.body?.note,
          },
        });
        if (!clean[memberId]) return res.status(400).json({ error: 'Invalid payout record' });
        next[memberId] = clean[memberId];
      }

      await q.writePayouts(tenantId, key, next);

      // hunt_history is the source of truth, but lib/persistence.js keeps a SEPARATE
      // in-memory/file archive that the public archived-hunt route reads. Writing only
      // one silently diverges them. Match with statsStore's own huntKey(): a hunt with
      // a huntId keys on THAT, not on `${user.id}|${startedAt}` — matching on the
      // composite alone would miss every modern hunt.
      const mem = (archive || []).find(h => huntKey(h) === key);
      if (mem) {
        mem.payouts = next;
        if (typeof persistArchive === 'function') persistArchive();
      }

      invalidate(tenantId, userId);
      res.json({ ok: true, payouts: next });
    } catch (e) {
      console.error('[ledger] patch failed:', e.message);
      res.status(500).json({ error: 'Failed to update payout' });
    }
  });

  return router;
};
