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

module.exports = { CATEGORIES, isCategory, cleanMember, cleanMembers, mergeEquity };
