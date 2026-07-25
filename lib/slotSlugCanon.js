// Canonical identity for a Rainbet slug. Answers exactly one question: do two slugs
// refer to the same game? It deliberately does NOT produce a canonical slug —
// Rainbet serves some games as playn-go-… and others as play-n-go-… with no
// derivable rule, so the real slug only ever comes from the games API. The catalog
// file stores that real slug; this module just detects variants of it.
//
// Used by lib/slots.js and scripts/check_new_slots.js so the slot.report merge
// can't re-add a variant of a row the catalog already has. Both require this one
// module rather than mirroring a table, unlike SLUG_FIXES.

// Provider prefixes seen in Rainbet slugs, longest first so "play-n-go" wins over "play".
const PROVIDER_PREFIXES = [
  'voltent-wazdan', 'big-time-gaming', 'massive-studios', 'backseat-gaming', 'bullshark-games',
  'foxhound-games', 'kitsune-studios', 'pineapple-play', 'print-studios', 'peter-and-sons',
  'pragmatic-play', 'nownow-gaming', 'mascot-gaming', 'penguin-king', 'amigo-gaming',
  'clutch-gaming', 'jinx-gaming', 'relax-gaming', 'trusty-gaming', 'elk-studios', 'push-gaming',
  'iron-dog-studio', 'red-tiger', 'playn-go', 'play-n-go', 'peter-sons', 'shady-lady', 'iron-dog',
  'blueprint', 'spinomenal', 'thunderkick', 'yggdrasil', 'quickspin', 'clawbuster', 'endorphina',
  'ace-roll', '1spin4win', 'habanero', 'platipus', 'avatarux', 'slotmill', 'fantasma', 'isoftbet',
  'onetouch', 'playnetic', 'zillion', 'truelab', 'popiplay', 'gamomat', 'gameart', 'belatra',
  'nolimit', 'playngo', 'bgaming', 'voltent', 'betsoft', 'netent', 'wazdan', 'hacksaw', 'pgsoft',
  'mascot', 'penguin', '3-oaks', 'aceroll', 'nownow', 'amigo', 'retro',
].sort((a, b) => b.length - a.length);

// Prefix variants that mean the same studio.
const PROVIDER_ALIASES = {
  'play-n-go': 'playngo',
  'playn-go': 'playngo',
  'nownow-gaming': 'nownow',
  'voltent-wazdan': 'wazdan',
  'mascot-gaming': 'mascot',
  'penguin-king': 'penguin',
  'amigo-gaming': 'amigo',
  'ace-roll': 'aceroll',
  'peter-and-sons': 'peter-sons',
  'iron-dog-studio': 'iron-dog',
};

function splitSlug(rainbetSlug) {
  const s = String(rainbetSlug || '').toLowerCase();
  for (const p of PROVIDER_PREFIXES) {
    if (s.startsWith(p + '-')) return { providerToken: p, gameSlug: s.slice(p.length + 1) };
  }
  const i = s.indexOf('-');
  if (i > 0) return { providerToken: s.slice(0, i), gameSlug: s.slice(i + 1) };
  return { providerToken: '', gameSlug: s };
}

// "and" is dropped because Rainbet and slot.report disagree on it freely
// (hacksaw-rusty-curly vs hacksaw-rusty-and-curly are one game). The \band\b
// boundary keeps it from eating the "and" inside Andar Bahar or Sand.
function gameKey(gameSlug) {
  return String(gameSlug || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\band\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function canonKey(rainbetSlug) {
  const { providerToken, gameSlug } = splitSlug(rainbetSlug);
  const provider = PROVIDER_ALIASES[providerToken] || providerToken;
  return `${provider}:${gameKey(gameSlug)}`;
}

module.exports = { canonKey, splitSlug, gameKey, PROVIDER_ALIASES, PROVIDER_PREFIXES };
