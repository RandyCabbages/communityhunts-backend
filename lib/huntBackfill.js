// Owner-gated bulk backfill planner for the admin Hunt Importer (spec §3 Track B). Pure except
// for the injected async isKnownAccount — no pgPool, no fs, no Date.now() (the caller injects
// `now`), so every rule here is unit-testable.
//
// Reuses the Track A construction path (validateImport + buildImportedHunt) so a hunt imported in
// bulk is identical to one pushed live over the API — same idempotent huntId, same _approxRate
// flag, same fail-closed identity vetting. The ONLY relaxation is the 48h age guard: a backfill is
// old history by definition (maxAgeMs: Infinity). Everything else — non-empty bonuses, known
// currency, startedAt <= endedAt <= now — is enforced unchanged.

const { validateImport, buildImportedHunt } = require('./huntImport');
const { vetEquityIdentity } = require('./identityWrites');

const rawExternalId = (raw) =>
  raw && typeof raw === 'object' && typeof raw.externalId === 'string' ? raw.externalId : null;

// Plan (do not write) an import batch. `hunts` holds the built objects for the accepted rows in
// input order — the caller hands each to archiveHunt on commit. creates/updates/rejects are the
// human-reviewable diff.
async function planImport(rows, { tenantId, hostDiscordId, now, existingIds, isKnownAccount }) {
  const creates = [], updates = [], rejects = [], hunts = [];
  const seenInBatch = new Set(); // huntId produced by an earlier row in THIS batch

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index];
    const parsed = validateImport(raw, { now, maxAgeMs: Infinity });
    if (!parsed.ok) {
      rejects.push({ index, externalId: rawExternalId(raw), code: parsed.code, message: parsed.message });
      continue;
    }

    const hunt = buildImportedHunt(parsed.value, { tenantId, hostDiscordId });

    // Two rows carrying the same externalId hash to the same huntId; committing both would make
    // the second silently overwrite the first inside one batch. Reject the later one loudly.
    if (seenInBatch.has(hunt.huntId)) {
      rejects.push({ index, externalId: parsed.value.externalId, code: 'duplicate_external_id',
        message: `externalId "${parsed.value.externalId}" appears more than once in this batch` });
      continue;
    }
    seenInBatch.add(hunt.huntId);

    // Same fail-closed vetting the public write path runs: an asserted discordId that isn't a real,
    // known account is STRIPPED, never stored. prev=[] so every id is treated as new.
    const vetted = await vetEquityIdentity([], hunt.equity, { isKnownAccount });
    hunt.equity = vetted.rows;

    const summary = {
      index, externalId: parsed.value.externalId, huntId: hunt.huntId,
      huntType: parsed.value.huntType, currency: parsed.value.currency,
      bonuses: hunt.bonuses.length, equity: hunt.equity.length,
      rejectedIdentities: vetted.rejected.length,
      startedAt: hunt.startedAt, endedAt: hunt.archivedAt,
    };
    (existingIds.has(hunt.huntId) ? updates : creates).push(summary);
    hunts.push(hunt);
  }

  return { creates, updates, rejects, hunts };
}

module.exports = { planImport };
