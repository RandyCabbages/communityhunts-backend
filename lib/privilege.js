// Shared "is this request's user privileged" gate. Privilege = Owner/Admin OR King (tenant host)
// OR Mod OR Supporter — the same ladder the badge roster uses. reqIsMod already folds in platform
// admins, so it covers Owner+Mod. Supporters + Owners are global; King + Mod are tenant-scoped
// (resolved from req.tenant). DI so it stays trivially unit-testable with no DB.
module.exports = function makePrivilege({ reqIsMod, supporters }) {
  function isPrivileged(req) {
    if (!req || !req.user) return false;
    if (typeof reqIsMod === 'function' && reqIsMod(req)) return true; // owner/admin + mod
    if (supporters && supporters.isSupporter(req.user.id)) return true; // supporter (global)
    const hostId = req.tenant && req.tenant.hostDiscordId; // king (tenant host)
    if (hostId && String(hostId) === String(req.user.id)) return true;
    return false;
  }
  return { isPrivileged };
};
