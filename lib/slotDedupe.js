// Pure dedup resolution. Given catalog entries plus Rainbet's authoritative live
// games (keyed by stripped name), decide which rows survive. Never deletes a game
// the catalog uniquely knows about — removing delisted games is
// scripts/reconcile_rainbet.js's job, with its 3-day grace. This only ever merges
// rows that refer to the same game.
const { canonKey, splitSlug, gameKey } = require('./slotSlugCanon');

const slugGameKey = s => gameKey(splitSlug(s).gameSlug);

const nameKey = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// liveByNameKey maps nameKey -> ARRAY of live Rainbet games with that name. It has to
// be an array: two studios genuinely ship a game called "Bad Santa", and collapsing
// the live set to one entry per name would make the second look like a duplicate and
// delete a real game.
function planDedupe(entries, liveByNameKey) {
  const groups = new Map();
  for (const e of entries) {
    const k = nameKey(e.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const keep = [], drop = [], report = [];
  let distinctKept = 0;

  for (const [k, rows] of groups) {
    if (rows.length === 1) { keep.push(rows[0]); continue; }

    const liveList = liveByNameKey.get(k) || [];
    const liveCanons = new Set(liveList.map(g => canonKey(g.url)));

    // Bucket by canonKey. canonKey is provider-scoped, so two studios can never
    // land in the same bucket — a bucket is always one game's slug variants.
    const byCanon = new Map();
    for (const r of rows) {
      const c = canonKey(r.rainbetSlug);
      if (!byCanon.has(c)) byCanon.set(c, []);
      byCanon.get(c).push(r);
    }

    // Within every bucket, collapse variants onto the slug Rainbet serves.
    const bucketWinners = [];
    for (const [canon, bucket] of byCanon) {
      const liveHit = liveList.find(g => canonKey(g.url) === canon);
      const winner = (liveHit && bucket.find(r => r.rainbetSlug === liveHit.url))
        || bucket.find(r => r.thumb)
        || bucket[0];
      bucketWinners.push({ canon, winner });
      drop.push(...bucket.filter(r => r !== winner));
    }

    if (byCanon.size === 1) {
      keep.push(bucketWinners[0].winner);
      report.push({ key: k, action: 'collapsed', kept: bucketWinners[0].winner.rainbetSlug });
      continue;
    }

    // Several studios claim this name. A bucket Rainbet does not serve is only a
    // duplicate if it is a mis-attributed PROVIDER PREFIX for a game we are keeping —
    // i.e. its game slug is identical and only the studio differs. Rows whose game
    // slug genuinely differs ("floating-dragon" vs "floating-dragon-holdspin",
    // "money-blitz" vs "money-stacks") are separate games that merely share a name
    // field, and dropping them would delete real games. Keep those.
    const matched = bucketWinners.filter(b => liveCanons.has(b.canon));
    if (matched.length) {
      const keptGameKeys = new Set(matched.map(b => slugGameKey(b.winner.rainbetSlug)));
      const unmatched = bucketWinners.filter(b => !liveCanons.has(b.canon));
      const prefixDups = unmatched.filter(b => keptGameKeys.has(slugGameKey(b.winner.rainbetSlug)));
      const survivors = unmatched.filter(b => !keptGameKeys.has(slugGameKey(b.winner.rainbetSlug)));

      keep.push(...matched.map(b => b.winner), ...survivors.map(b => b.winner));
      drop.push(...prefixDups.map(b => b.winner));
      distinctKept += matched.length + survivors.length;
      report.push({
        key: k,
        action: prefixDups.length ? 'cross-collapse' : 'kept-distinct',
        kept: [...matched, ...survivors].map(b => b.winner.rainbetSlug),
        dropped: prefixDups.map(b => b.winner.rainbetSlug),
      });
    } else {
      keep.push(...bucketWinners.map(b => b.winner));
      distinctKept += bucketWinners.length;
      report.push({ key: k, action: 'kept-unarbitrated', slugs: bucketWinners.map(b => b.winner.rainbetSlug) });
    }
  }

  return { keep, drop, groups: report, distinctKept };
}

module.exports = { planDedupe, nameKey };
