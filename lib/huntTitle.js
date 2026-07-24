// Pure helpers for shared-hunt (Mod/Affiliate) titles. `now` is injected (ms) so this is
// deterministic and unit-testable; formatting is manual (no locale/ICU dependency).
const MAX_TITLE_LEN = 80;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Blank/absent title → a dated default. mod → "Bean's Hunt — Jul 24"; affiliate → "Bean Affiliate
// Hunt — Jul 24"; vip → "Bean VIP Hunt — Jul 24".
function defaultHuntTitle(hostName, kind, now) {
  const host = (hostName && String(hostName).trim()) || 'Host';
  const d = new Date(now);
  const date = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return kind === 'affiliate' ? `${host} Affiliate Hunt — ${date}`
       : kind === 'vip'       ? `${host} VIP Hunt — ${date}`
       : `${host}'s Hunt — ${date}`;
}

// Trim, cap length, strip ASCII control chars (< 0x20 and DEL 0x7f). Non-strings → ''.
function sanitizeTitle(s) {
  if (typeof s !== 'string') return '';
  const stripped = Array.from(s)
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; })
    .join('');
  return stripped.trim().slice(0, MAX_TITLE_LEN);
}

module.exports = { defaultHuntTitle, sanitizeTitle, MAX_TITLE_LEN };
