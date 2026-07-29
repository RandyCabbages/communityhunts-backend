// A hunt's stable public share token, and the URL a person can actually open.
//
// Extracted from routes/share.routes.js because the Discord bot's public API now needs the same
// link for a community's shared hunt: POST /api/public/v1/hunts/shared/open answers with the URL
// to send people to. Two copies of "mint a token if there isn't one" would drift, and the copy
// that drifted would be the one handing out a SECOND token for an owner who already has one — at
// which point "stable per owner", which is the whole promise the share link is built on, quietly
// stops holding and previously-shared links start pointing at nothing.
//
// A factory over its deps because `shareTokens` is a mutable singleton owned by lib/persistence.js
// and must be mutated by reference, never re-created here.

module.exports = function shareLinks({ shareTokens, tokenForOwner, persistShareTokens, hunts, uid,
                                       frontendUrl }) {
  /**
   * The owner's share token, minting one only if they have none. Idempotent: the token lives in an
   * owner-keyed map rather than on the hunt, so it survives reset/start/end and the same link keeps
   * working across runs.
   */
  function ensureShareToken(ownerKey) {
    const existing = tokenForOwner(ownerKey);      // 1) reuse a stable token if one exists
    if (existing) return existing;

    const hunt = hunts[ownerKey];
    const token = (hunt && hunt.shareToken) || uid(); // 2) adopt a legacy per-hunt token, else mint
    shareTokens[token] = ownerKey;
    persistShareTokens();
    return token;
  }

  /**
   * Frontend route `/:slug/share/:token` (frontend src/App.js). The backend never serves that page;
   * it only resolves what sits behind the token (GET /api/share/:token), so this is the one place
   * that has to know the frontend's URL shape.
   */
  function shareUrl(tenantId, token) {
    const base = String(frontendUrl || '').replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(tenantId || 'bean')}/share/${encodeURIComponent(token)}`;
  }

  return { ensureShareToken, shareUrl };
};
