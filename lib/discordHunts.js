// The Discord bot's half of a shared hunt: which hunt a giveaway maps to, and how its winners
// are folded onto that hunt's equity sheet.
//
// Pure and injected throughout — no fs, no pool, no clock — because the one operation here that
// matters is a merge over money, and a merge is only trustworthy if it can be tested exhaustively
// without a database.

const { isRealDiscordId } = require('./userIds');

const CATEGORIES = ['affiliate', 'vip'];

/** The public category a bot may name. `topLb` is not one: those run in the VIP hunt. */
function isCategory(value) {
  return CATEGORIES.includes(value);
}

// A run key is the hunt key and the specific RUN in one opaque string: `__affiliate_hunt__#<huntId>`.
//
// One string rather than two fields, deliberately. A caller stores exactly one value ("the hunt this
// giveaway opened against") and hands it back on every write, so the stale-run guard works without
// the caller — or anything between the caller and us — having to learn a second field. The Discord
// bot keeps it on a row in a THIRD service, and a guard that needs a schema change over there to
// take effect is a guard that stays off.
//
// The plain key alone cannot do this job: `__affiliate_hunt__` is the same string for every run of
// that category, so comparing it can never see a mod resetting the hunt underneath a giveaway.
//
// `#` is safe as a separator: hunt keys are `__<kind>_hunt__[:<tenant-slug>]` and huntIds are hex.
const RUN_SEP = '#';

/** `key` alone when there is no run to pin to — a bare key stays valid input everywhere. */
function encodeRunKey(key, huntId) {
  return huntId ? `${key}${RUN_SEP}${huntId}` : String(key);
}

/** Split on the FIRST separator, so a stray one cannot smuggle a different hunt key past the check. */
function decodeRunKey(value) {
  const raw = String(value == null ? '' : value);
  const at = raw.indexOf(RUN_SEP);
  if (at < 0) return { key: raw, huntId: null };
  return { key: raw.slice(0, at), huntId: raw.slice(at + 1) || null };
}

/** The shared hunt a category maps to. Key builders are injected — hunts-core owns their shape. */
function keyForCategory(category, tenantId, { affiliateHuntKey, vipHuntKey }) {
  if (category === 'affiliate') return affiliateHuntKey(tenantId);
  if (category === 'vip') return vipHuntKey(tenantId);
  return null;
}

/**
 * Is there work in this run that opening a new one would throw away?
 *
 * **Deliberately not `huntHasContent`.** That one counts an equity row with `amount > 0` as
 * content, and a freshly opened affiliate/VIP run is SEEDED with the host at $1000 — so
 * huntHasContent is true the instant the run exists, and gating on it would make every open after
 * the first a 409 forever. What matters here is whether a person has put anything in: a bonus, a
 * call, or an equity row that is not the server's own seed.
 *
 * An ended run (`archivedAt`) is never in the way — it is already in the archive, and opening the
 * next run is exactly what should happen.
 */
function sharedRunHasWork(hunt) {
  if (!hunt || hunt.archivedAt) return false;
  if (Array.isArray(hunt.bonuses) && hunt.bonuses.length > 0) return true;
  if (Array.isArray(hunt.calls) && hunt.calls.length > 0) return true;
  return Array.isArray(hunt.equity)
    && hunt.equity.some((row) => row && row.id !== 'bean_auto' && row.id !== 'creator_auto');
}

/**
 * A member as the bot sends it. No `id`: the bot has never seen this sheet and must not invent
 * row ids for it.
 */
function cleanMember(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  if (!name) return null;

  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const row = { name, amount, isRollWinner: raw.isRollWinner === true };
  // vetEquityIdentity decides whether to KEEP it — this only refuses to carry junk that far,
  // and it asks the same question the rest of the codebase asks so there is one answer to
  // "is that a Discord id" rather than two that can drift.
  if (isRealDiscordId(raw.discordId)) row.discordId = String(raw.discordId);
  return row;
}

function cleanMembers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanMember).filter(Boolean);
}

/** Case- and space-insensitive, because a host types a name and a bot sends an alias. */
const nameKey = (name) => String(name || '').trim().toLowerCase();

/**
 * Fold the bot's winners onto the sheet that is already there.
 *
 * **Existing rows are never dropped.** The shared-hunt PUT replaces whichever arrays it is given,
 * and `preserveRowIdentity` only stops an *absent* field clearing a known one — it does not stop a
 * short array deleting rows. A bot sending only its own winners through that path would delete
 * everyone a mod had added by hand, which is the vault-deletion failure class. So this is a merge,
 * and the merge is the endpoint rather than something the bot does read-modify-write against a
 * sheet several people are editing live.
 *
 * Matching is by `discordId` first and name second. The id is the strong claim; the name is what
 * lets a row a mod typed by hand be recognised as the same person rather than duplicated beside
 * it. Idempotent either way — the bot re-sends the same winners on every sweep, so a merge that
 * appended would grow the sheet all night.
 */
function mergeEquity(existing, incoming, { uid } = {}) {
  const rows = Array.isArray(existing) ? existing.map((r) => ({ ...r })) : [];

  const byId = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (row && row.discordId) byId.set(String(row.discordId), row);
    // First writer wins: if two rows share a name, the earlier one is the one a merge should
    // land on rather than silently retargeting to the newer duplicate.
    if (row && row.name && !byName.has(nameKey(row.name))) byName.set(nameKey(row.name), row);
  }

  let added = 0;
  let updated = 0;

  for (const member of incoming) {
    const match =
      (member.discordId && byId.get(member.discordId)) || byName.get(nameKey(member.name)) || null;

    if (match) {
      match.amount = member.amount;
      match.isRollWinner = true;
      // Only ever fills a blank. Overwriting an id a mod or an earlier vetted write established
      // would let a name collision reassign somebody else's equity to this winner.
      if (member.discordId && !match.discordId) {
        match.discordId = member.discordId;
        byId.set(member.discordId, match);
      }
      updated += 1;
      continue;
    }

    const row = { id: uid(), name: member.name, amount: member.amount, isRollWinner: true };
    if (member.discordId) {
      row.discordId = member.discordId;
      byId.set(member.discordId, row);
    }
    byName.set(nameKey(member.name), row);
    rows.push(row);
    added += 1;
  }

  return { rows, added, updated };
}

/** Discord caps a modal at five action rows, so five is the most a caller can ever send. */
const MAX_SLOTS_PER_CALL = 5;
/** Matches the bot's own MAX_SLOT_NAME. A slot name is a game title, not a paragraph. */
const MAX_SLOT_NAME = 60;

/**
 * The slots as the box hands them over.
 *
 * Blank inputs are DROPPED rather than refused — the box has five fields and only the first is
 * required, so four blanks is the normal case, not an error.
 *
 * **A repeat inside one submission is deliberately kept.** Collapsing it here would silently
 * swallow a slot the caller typed twice; passing both through means the first is added and the
 * second comes back as a duplicate, which is what actually happened and what they should be told.
 */
function cleanSlots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const slot = value.replace(/\s+/g, ' ').trim().slice(0, MAX_SLOT_NAME);
    if (!slot) continue;
    out.push(slot);
    if (out.length >= MAX_SLOTS_PER_CALL) break;
  }
  return out;
}

/**
 * The equity row this caller already holds on the run, or null.
 *
 * This is the AUTHORISATION for a bot-filed call. The tenant key says which community the caller
 * is, and must not also mean "may call on anybody's behalf" — so the same question the session
 * route asks through `isEquityMember` is asked here, against the run's own sheet.
 *
 * `discordId` first and name second, the same order mergeEquity matches in, so a winner written
 * name-only at check-in is recognised as themselves — and still recognised later, once they sign
 * in and their id lands on the row.
 */
function findEquityRow(equity, { discordId, name }) {
  const rows = Array.isArray(equity) ? equity : [];
  if (discordId) {
    const byId = rows.find((r) => r && r.discordId && String(r.discordId) === String(discordId));
    if (byId) return byId;
  }
  const key = nameKey(name);
  if (!key) return null;
  return rows.find((r) => r && nameKey(r.name) === key) || null;
}

module.exports = { CATEGORIES, isCategory, keyForCategory, sharedRunHasWork,
                   encodeRunKey, decodeRunKey,
                   cleanMember, cleanMembers, mergeEquity,
                   cleanSlots, findEquityRow, MAX_SLOTS_PER_CALL };
