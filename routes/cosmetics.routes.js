// Cosmetics purchase + inventory routes.
// One-time Stripe payments for individual cosmetic items.
// Owned items stored in user_settings.cosmeticsOwned array.

const express = require('express');

// Item tier requirements — mirrors frontend catalog.js.
// 'free' = anyone, 'basic'/'pro'/'ultimate' = subscription tier required,
// null = purchase-only (must be in cosmeticsOwned).
const ITEM_TIERS = {
  card_standard:'free', card_slate:'free', card_bean:'free', card_jeter:'free', card_backnine:'free',
  card_walker:'free', card_goofer:'free', card_thisisfine:'free', card_cabbage:'free', card_upgrade:'free', card_mod:'free',
  card_shooter:'free', card_bam:'free', card_cat:'free', card_rasseewz:'free', card_sverrir:'free', card_birdvision:'free', card_tylerrr:'free',
  card_emerald:'basic', card_copper:'basic', card_ocean:'basic',
  card_neon:'pro', card_arctic:'pro', card_toxic:'pro',
  card_holo:'ultimate', card_obsidian:'ultimate', card_celestial:'ultimate',
  card_gold:null, card_cyber:null, card_blood:null, card_phantom:null,
  card_inferno:null, card_galaxy:null, card_diamond:null, card_dragon:null,

  theme_midnight:'free',
  theme_ember:'basic', theme_frost:'pro', theme_neon:'pro', theme_hacker:'ultimate',
  theme_gold:null, theme_rose:null, theme_sunset:null,

  sound_minimal:'free', sound_treasure:'basic', sound_tropical:'basic',
  sound_retro:'pro', sound_neon:'pro', sound_medieval:'pro',
  sound_hype:'ultimate',
  sound_casino:null, sound_scifi:null, sound_vapor:null, sound_anime:null, sound_pirate:null,

  effect_confetti:'free', effect_flash:'basic', effect_shake:'basic', effect_sparkles:'basic',
  effect_coins:'pro', effect_meteors:'pro', effect_neon:'pro',
  effect_lightning:'ultimate', effect_slots:'ultimate',
  effect_fireworks:null, effect_diamonds:null, effect_money:null,

  bg_stars:'free', bg_particles:'basic', bg_embers:'basic',
  bg_aurora:'pro', bg_nebula:'pro', bg_space:'pro',
  bg_matrix:'ultimate',
  bg_smoke:null, bg_grid:null,
};

// Mod-only items — equippable only by community mods (reqIsMod) or platform admins. Tier above is
// 'free' so grant/purchase validation passes; the real mod gate is enforced on the equip path
// (settings.routes.js PUT /api/settings cosmetics save loop) where `req` (and thus reqIsMod) exists.
const MOD_ONLY_ITEMS = new Set(['card_mod']);

const TIER_RANK = { free: 0, basic: 1, pro: 2, ultimate: 3, admin: 99 };

function isItemAccessible(itemId, userTier, ownedIds) {
  const itemTier = ITEM_TIERS[itemId];
  if (itemTier === undefined) return false;
  if (userTier === 'admin') return true;
  if (itemTier === 'free') return true;
  if (ownedIds && ownedIds.includes(itemId)) return true;
  if (itemTier && userTier) return (TIER_RANK[userTier] || 0) >= (TIER_RANK[itemTier] || 0);
  return false;
}

// Stripe price IDs for purchasable cosmetics (one-time payments).
const COSMETIC_PRICES = {
  theme_gold:       'price_1TqCEBRrpLw0LHPUDL2A6bIg',
  theme_rose:       'price_1TqCEHRrpLw0LHPUVfVU3CYH',
  theme_sunset:     'price_1TqCEIRrpLw0LHPUc5pChpA6',
  sound_casino:     'price_1TqCEJRrpLw0LHPUGiKH3gPD',
  sound_scifi:      'price_1TqCEKRrpLw0LHPUa59zEgVM',
  effect_fireworks: 'price_1TqCELRrpLw0LHPU2pV0aW3C',
  flair_diamond:    'price_1TqCEMRrpLw0LHPU3F7buvc0',
  flair_flame:      'price_1TqCENRrpLw0LHPUygOiFMWo',
  flair_skull:      'price_1TqCEORrpLw0LHPULF8qdB6e',
  flair_rocket:     'price_1TqCEPRrpLw0LHPUdak9GC16',
  bg_grid:          'price_1TqCERRrpLw0LHPUdlVzRAX6',
  bg_smoke:         'price_1TqCERRrpLw0LHPUZeuRe0zK',
};

// ── Purchase eligibility ────────────────────────────────────────────────────
// Mirrors frontend src/auth/purchase.js + roles.isAffiliate. A user may BUY from the Shop
// (cosmetics + the Full extension) only if they are an admin, OR hold an active individual
// subscription, OR carry the affiliate/VIP guild role. Fails OPEN when guild-role flags are
// absent (roles not yet determined — e.g. DISCORD_GUILD_ID unset), matching the frontend's
// hasGuildFlags net so a config gap can't lock buyers out.
function subActive(sub) {
  if (!sub || sub.tier === 'free') return false;
  if (!sub.expiresAt) return true;
  return new Date(sub.expiresAt) > new Date();
}
function hasGuildFlags(u) {
  return !!(u && ('isAffiliate' in u || 'isDiscordVip' in u || 'isDiscordMod' in u));
}
function isAffiliateLike(u, isAdmin) {
  if (!u) return false;
  if (isAdmin && isAdmin(u)) return true;
  if (!hasGuildFlags(u)) return true; // roles undetermined → fail open (matches frontend roles.js)
  return !!(u.isAffiliate || u.isDiscordVip);
}
async function isPurchaseEligible(u, subscriptions, isAdmin) {
  if (isAffiliateLike(u, isAdmin)) return true;
  return subActive(await subscriptions.getSubscription(u.id));
}
const NOT_ELIGIBLE_MSG = 'Join a community or get an individual plan to purchase.';

module.exports = function cosmeticsRoutes(deps) {
  const { requireAuth, settings, stripeLib, subscriptions, FRONTEND_URL, isAdmin, reqHasFullExtension } = deps;
  const { getSettings, saveSettings } = settings;
  const router = express.Router();

  router.get('/api/cosmetics/owned', requireAuth, async (req, res) => {
    const s = await getSettings(req.user.id);
    res.json({ owned: s.cosmeticsOwned || [] });
  });

  router.post('/api/cosmetics/purchase', requireAuth, async (req, res) => {
    try {
      if (!stripeLib || !stripeLib.isEnabled()) return res.status(503).json({ error: 'Payments not configured' });
      if (!(await isPurchaseEligible(req.user, subscriptions, isAdmin))) return res.status(403).json({ error: NOT_ELIGIBLE_MSG });
      const { itemId } = req.body || {};
      if (!itemId || !(itemId in ITEM_TIERS)) return res.status(400).json({ error: 'Invalid item' });

      const s = await getSettings(req.user.id);
      const owned = s.cosmeticsOwned || [];
      if (owned.includes(itemId)) return res.json({ alreadyOwned: true });

      const priceId = COSMETIC_PRICES[itemId];
      if (!priceId) return res.status(400).json({ error: 'Item not available for individual purchase' });

      const customerId = await stripeLib.getOrCreateCustomer(
        req.user.id, req.user.email || null, req.user.displayName || req.user.username
      );
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${FRONTEND_URL}/shop?purchased=${itemId}`,
        cancel_url: `${FRONTEND_URL}/shop`,
        metadata: { userId: req.user.id, cosmeticItem: itemId },
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('[cosmetics] purchase error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Full (Rainbet) extension — a recurring $5/mo subscription (NOT a one-time cosmetic).
  // Separate endpoint because the cosmetics purchase above is mode:'payment', which Stripe
  // rejects for a recurring price. Access is granted/revoked by the subscription webhook.
  router.post('/api/extension/subscribe', requireAuth, async (req, res) => {
    try {
      if (!stripeLib || !stripeLib.isEnabled()) return res.status(503).json({ error: 'Payments not configured' });
      if (!process.env.STRIPE_PRICE_EXT_FULL) return res.status(503).json({ error: 'Extension subscription not configured yet' });
      // Already entitled (VIP/mod/guild-VIP/plan/grant) → never create a paid sub for it.
      if (await reqHasFullExtension(req)) return res.json({ alreadyEntitled: true });
      if (!(await isPurchaseEligible(req.user, subscriptions, isAdmin))) return res.status(403).json({ error: NOT_ELIGIBLE_MSG });
      const { url } = await stripeLib.createExtensionSubscriptionSession(
        req.user.id,
        `${FRONTEND_URL}/shop/extension?subscribed=1`,
        `${FRONTEND_URL}/shop/extension`,
        req.user.email || null,
        req.user.displayName || req.user.username
      );
      res.json({ url });
    } catch (e) {
      console.error('[extension] subscribe error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router._grantItem = async function grantItem(userId, itemId) {
    if (!(itemId in ITEM_TIERS)) return;
    const s = await getSettings(userId);
    const owned = s.cosmeticsOwned || [];
    if (!owned.includes(itemId)) {
      owned.push(itemId);
      s.cosmeticsOwned = owned;
      await saveSettings(userId, s);
      console.log(`[cosmetics] granted ${itemId} to ${userId}`);
    }
  };

  // Exported for use by settings.routes.js cosmetic equip validation
  router._isItemAccessible = isItemAccessible;
  router._ITEM_TIERS = ITEM_TIERS;

  return router;
};

module.exports.isItemAccessible = isItemAccessible;
module.exports.ITEM_TIERS = ITEM_TIERS;
module.exports.MOD_ONLY_ITEMS = MOD_ONLY_ITEMS;
