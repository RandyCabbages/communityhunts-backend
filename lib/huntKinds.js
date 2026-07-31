// The hunt KIND vocabulary: what kind of run this is, as distinct from `huntType` (who it
// belongs to — community/solo/vip/affiliate). The two are orthogonal and must not be merged:
// a tournament matchup is still a natty run or still a buy hunt.
//
// Keys are neutral and fixed because they are stored on hunts and published over the public
// API; the words a community shows are per-tenant, resolved the same way hunt TYPE labels are
// (lib/apiIdentity.js). Bean says "Natty"; another community may not.

const HUNT_KINDS = ['natty', 'standard', 'buy', 'hidden5'];

const DEFAULT_HUNT_KIND_LABELS = {
  natty: 'Natty',
  standard: 'Standard bonus hunt',
  buy: 'Buy hunt',
  hidden5: 'Hidden 5 scat hunt',
};

const apiConfigOf = (t) => ((t && t.branding && t.branding.api) || {});

function resolveHuntKindLabels(tenant) {
  const raw = apiConfigOf(tenant).huntKindLabels;
  const out = { ...DEFAULT_HUNT_KIND_LABELS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [kind, label] of Object.entries(raw)) {
      // Unknown keys are dropped, not passed through: the label map stays a total function
      // over HUNT_KINDS and nothing else.
      if (!HUNT_KINDS.includes(kind)) continue;
      if (typeof label !== 'string') continue;
      const trimmed = label.trim().slice(0, 40);
      if (trimmed) out[kind] = trimmed;
    }
  }
  return out;
}

// Trim, cap, and treat "" as an explicit clear. Returns undefined for "not present".
function str(v, max) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, n);
}

// Only keys actually PRESENT in the body come back. That is what lets the route use the same
// `!== undefined` guard as every other field, so a partial save can never blank something the
// caller did not mention.
function sanitizeHuntMeta(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const out = {};

  if (src.huntKind !== undefined) {
    if (src.huntKind === null) out.huntKind = null;
    else if (HUNT_KINDS.includes(src.huntKind)) out.huntKind = src.huntKind;
  }
  if (src.isTournament !== undefined) out.isTournament = !!src.isTournament;

  const provider = str(src.tournamentProvider, 60);
  if (provider !== undefined) out.tournamentProvider = provider;
  const round = str(src.tournamentRound, 60);
  if (round !== undefined) out.tournamentRound = round;
  const listId = str(src.pullListId, 64);
  if (listId !== undefined) out.pullListId = listId;

  const target = num(src.targetBonuses);
  if (target !== undefined) out.targetBonuses = target === null ? null : Math.round(target);
  const bet = num(src.betSize);
  if (bet !== undefined) out.betSize = bet;
  const spend = num(src.buySpend);
  if (spend !== undefined) out.buySpend = spend;

  return out;
}

module.exports = {
  HUNT_KINDS, DEFAULT_HUNT_KIND_LABELS, resolveHuntKindLabels, sanitizeHuntMeta,
};
