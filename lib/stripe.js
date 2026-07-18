// Stripe integration — checkout sessions, customer management, webhook handling.
// Owns stripe_customers and stripe_events tables. Delegates tier changes to
// subscriptions.setSubscription() so the existing admin/auth flows stay coherent.

const Stripe = require('stripe');

let pgPool = null;
let stripe = null;
let subscriptions = null;
let cosmeticGrantFn = null;
let communityProvisionFn = null;
let fullExtFn = null; // fn('grant'|'revoke', userId) — wired to featureGrants add/remove('full_extension')

// Monthly price IDs — env vars (set in Railway before the code existed).
const PRICE_MAP = {
  basic:             () => process.env.STRIPE_PRICE_BASIC,
  pro:               () => process.env.STRIPE_PRICE_PRO,
  ultimate:          () => process.env.STRIPE_PRICE_ULTIMATE,
};
// Annual price IDs — hardcoded (static). Doubled prices wired 2026-07-17
// ($79.99 / $159.99 / $319.99). The ultimate annual was recreated as /year on
// 2026-07-17 (the pre-created doubled one was mistakenly /month — archived).
const ANNUAL_PRICE_MAP = {
  basic:    () => 'price_1TuOYDRrpLw0LHPUPUkrUqXY',
  pro:      () => 'price_1TuOYhRrpLw0LHPUbKHswJe4',
  ultimate: () => 'price_1TuOfJRrpLw0LHPUPs43kdGH',
};
// Community plan price IDs (monthly) — created live via MCP (self-serve community onboarding).
// Env override for flexibility; hardcoded fallback so it works without extra Railway config.
// Starter plan killed + Pro/Partner repriced 2026-07-17 — see annual map below.
const COMMUNITY_PRICE_MAP = {
  community_pro:     () => process.env.STRIPE_PRICE_COMMUNITY_PRO     || 'price_1TuPJjRrpLw0LHPULpKGW6FR',
  community_partner: () => process.env.STRIPE_PRICE_COMMUNITY_PARTNER || 'price_1TuPJrRrpLw0LHPUaiPDcUOI',
};
// Community plan price IDs (annual) — added 2026-07-17. Community checkout is contact-us/manual
// (createCommunityCheckoutSession is not wired for interval selection); this map exists so a
// manually-created annual community subscription resolves to the right tier via the webhook
// (see buildPriceTierMap / tierFromSubscription).
const COMMUNITY_ANNUAL_PRICE_MAP = {
  community_pro:     () => process.env.STRIPE_PRICE_COMMUNITY_PRO_ANNUAL     || 'price_1TuPJnRrpLw0LHPUtZwOlRYc',
  community_partner: () => process.env.STRIPE_PRICE_COMMUNITY_PARTNER_ANNUAL || 'price_1TuPJwRrpLw0LHPUk898fnRC',
};
const COMMUNITY_PLANS = new Set(['community_pro', 'community_partner']);

// Stripe tier → subscription tier mapping (checkout metadata carries the tier key).
const TIER_FROM_PRICE = {};
function buildPriceTierMap() {
  for (const [tier, priceFn] of Object.entries(PRICE_MAP)) {
    const priceId = priceFn();
    if (priceId) TIER_FROM_PRICE[priceId] = tier;
  }
  for (const [tier, priceFn] of Object.entries(ANNUAL_PRICE_MAP)) {
    const priceId = priceFn();
    if (priceId) TIER_FROM_PRICE[priceId] = tier;
  }
  for (const [tier, priceFn] of Object.entries(COMMUNITY_ANNUAL_PRICE_MAP)) {
    const priceId = priceFn();
    if (priceId) TIER_FROM_PRICE[priceId] = tier;
  }
}

async function initStripe(deps) {
  pgPool = deps.pgPool;
  subscriptions = deps.subscriptions;

  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) {
    console.log('[stripe] STRIPE_SECRET_KEY not set — Stripe disabled');
    return;
  }
  stripe = new Stripe(secretKey);

  if (!pgPool) { console.log('[stripe] no DB — Stripe tables skipped'); return; }

  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS stripe_customers (
        user_id            TEXT PRIMARY KEY,
        stripe_customer_id TEXT UNIQUE NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        stripe_event_id TEXT PRIMARY KEY,
        processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('[stripe] Postgres tables ready');
  } catch (e) {
    console.error('[stripe] init failed:', e.message);
  }

  buildPriceTierMap();
}

function isEnabled() { return !!stripe; }

// ── Customer management ─────────────────────────────────────────

async function getStripeCustomerId(userId) {
  if (!pgPool) return null;
  const { rows } = await pgPool.query(
    'SELECT stripe_customer_id FROM stripe_customers WHERE user_id=$1', [userId]);
  return rows[0]?.stripe_customer_id || null;
}

async function getOrCreateCustomer(userId, email, displayName) {
  let customerId = await getStripeCustomerId(userId);
  if (customerId) return customerId;

  const customer = await stripe.customers.create({
    email: email || undefined,
    name: displayName || undefined,
    metadata: { userId },
  });
  customerId = customer.id;

  await pgPool.query(
    `INSERT INTO stripe_customers (user_id, stripe_customer_id)
     VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id=$2`,
    [userId, customerId]);

  return customerId;
}

// ── Checkout ────────────────────────────────────────────────────

const USER_TIERS = new Set(['basic', 'pro', 'ultimate']);

async function createCheckoutSession(userId, tier, successUrl, cancelUrl, email, displayName, interval) {
  if (!stripe) throw new Error('Stripe not configured');

  if (!USER_TIERS.has(tier)) {
    throw new Error('Community plans are set up with you directly — use the Add My Community form');
  }
  const annual = interval === 'year';
  const priceFn = annual ? (ANNUAL_PRICE_MAP[tier] || PRICE_MAP[tier]) : PRICE_MAP[tier];
  if (!priceFn) throw new Error(`Unknown tier: ${tier}`);
  const priceId = priceFn();
  if (!priceId) throw new Error(`Price not configured for tier: ${tier}`);

  const customerId = await getOrCreateCustomer(userId, email, displayName);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, tier },
    subscription_data: { metadata: { userId, tier } },
  });

  return { url: session.url, sessionId: session.id };
}

// Community self-serve checkout. Unlike the individual sub, a successful payment provisions a
// whole tenant — so the community details (slug/name/owner/accent) ride in the checkout metadata
// for the webhook to hand to createTenant. The subscription metadata carries them too, so a later
// cancellation (customer.subscription.deleted) can find + deactivate the tenant.
async function createCommunityCheckoutSession(userId, plan, community, successUrl, cancelUrl, email, displayName) {
  if (!stripe) throw new Error('Stripe not configured');
  if (!COMMUNITY_PLANS.has(plan)) throw new Error(`Unknown community plan: ${plan}`);
  const priceId = COMMUNITY_PRICE_MAP[plan]();
  if (!priceId) throw new Error(`Price not configured for ${plan}`);
  const customerId = await getOrCreateCustomer(userId, email, displayName);
  const meta = {
    type: 'community', ownerId: String(userId), plan,
    communitySlug: String(community.slug || ''), communityName: String(community.displayName || ''),
    accent: String(community.accent || ''), twitchChannel: String(community.twitchChannel || ''),
  };
  const session = await stripe.checkout.sessions.create({
    customer: customerId, mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl, cancel_url: cancelUrl,
    metadata: meta, subscription_data: { metadata: meta },
  });
  return { url: session.url, sessionId: session.id };
}

// Full (Rainbet) extension — a standalone recurring subscription (NOT a tier). The
// metadata `feature: 'full_extension'` lets the webhook grant/revoke access on the
// subscription lifecycle without touching the user's individual tier.
async function createExtensionSubscriptionSession(userId, successUrl, cancelUrl, email, displayName) {
  if (!stripe) throw new Error('Stripe not configured');
  const priceId = process.env.STRIPE_PRICE_EXT_FULL;
  if (!priceId) throw new Error('Full-extension price not configured');
  const customerId = await getOrCreateCustomer(userId, email, displayName);
  const meta = { feature: 'full_extension', userId: String(userId) };
  const session = await stripe.checkout.sessions.create({
    customer: customerId, mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl, cancel_url: cancelUrl,
    metadata: meta, subscription_data: { metadata: meta },
  });
  return { url: session.url, sessionId: session.id };
}

// ── Customer Portal ─────────────────────────────────────────────

async function createPortalSession(userId, returnUrl) {
  if (!stripe) throw new Error('Stripe not configured');
  const customerId = await getStripeCustomerId(userId);
  if (!customerId) throw new Error('No Stripe customer found');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// ── Webhook handling ────────────────────────────────────────────

function constructEvent(rawBody, signature) {
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

async function isEventProcessed(eventId) {
  if (!pgPool) return false;
  const { rows } = await pgPool.query(
    'SELECT 1 FROM stripe_events WHERE stripe_event_id=$1', [eventId]);
  return rows.length > 0;
}

async function markEventProcessed(eventId) {
  if (!pgPool) return;
  await pgPool.query(
    'INSERT INTO stripe_events (stripe_event_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [eventId]);
}

function tierFromSubscription(sub) {
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  buildPriceTierMap();
  return TIER_FROM_PRICE[priceId] || null;
}

async function handleWebhookEvent(event) {
  if (await isEventProcessed(event.id)) {
    console.log(`[stripe] event ${event.id} already processed, skipping`);
    return;
  }

  const type = event.type;
  console.log(`[stripe] webhook: ${type} (${event.id})`);

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const cosmeticItem = session.metadata?.cosmeticItem;
    if (userId && cosmeticItem && cosmeticGrantFn) {
      await cosmeticGrantFn(userId, cosmeticItem);
      console.log(`[stripe] cosmetic granted: user=${userId} item=${cosmeticItem}`);
    }
    const tier = session.metadata?.tier;
    if (userId && tier && subscriptions) {
      if (!USER_TIERS.has(tier)) {
        console.error(`[stripe] UNPROVISIONABLE checkout: user=${userId} tier=${tier} — handle manually`);
      } else {
        await subscriptions.setSubscription(userId, tier, null, 'stripe');
        console.log(`[stripe] checkout completed: user=${userId} tier=${tier}`);
      }
    }
    // Community self-serve checkout → provision the tenant (details are in the metadata).
    if (session.metadata?.type === 'community' && communityProvisionFn) {
      await communityProvisionFn('provision', session.metadata);
    }
    // Full-extension subscription → grant access.
    if (session.metadata?.feature === 'full_extension' && userId && fullExtFn) {
      await fullExtFn('grant', userId);
      console.log(`[stripe] full_extension granted: user=${userId}`);
    }
  }

  if (type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const userId = sub.metadata?.userId;
    // Full-extension sub: grant while active/trialing, revoke otherwise (past_due, unpaid,
    // canceled). Handled separately from tiers — this sub carries no tier.
    if (sub.metadata?.feature === 'full_extension' && userId && fullExtFn) {
      const active = sub.status === 'active' || sub.status === 'trialing';
      await fullExtFn(active ? 'grant' : 'revoke', userId);
      console.log(`[stripe] full_extension ${active ? 'granted' : 'revoked'} (updated): user=${userId} status=${sub.status}`);
    }
    const tier = tierFromSubscription(sub);
    if (userId && tier && USER_TIERS.has(tier) && subscriptions) {
      if (sub.status === 'active' || sub.status === 'trialing') {
        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;
        await subscriptions.setSubscription(userId, tier, periodEnd, 'stripe');
        console.log(`[stripe] subscription updated: user=${userId} tier=${tier}`);
      }
    }
  }

  if (type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    // Full-extension sub cancelled → revoke access. MUST come before the tier branch:
    // this sub carries metadata.userId but no tier, so the generic else would wrongly
    // downgrade the user's individual tier to free.
    if (sub.metadata?.feature === 'full_extension' && fullExtFn) {
      await fullExtFn('revoke', sub.metadata.userId);
      console.log(`[stripe] full_extension revoked (deleted): user=${sub.metadata.userId}`);
    } else if (sub.metadata?.type === 'community' && communityProvisionFn) {
      // Community sub cancelled → deactivate the tenant (do NOT touch the owner's individual sub).
      await communityProvisionFn('deactivate', sub.metadata);
    } else {
      const userId = sub.metadata?.userId;
      if (userId && subscriptions) {
        await subscriptions.setSubscription(userId, 'free', null, 'stripe');
        console.log(`[stripe] subscription deleted: user=${userId} → free`);
      }
    }
  }

  if (type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = invoice.customer;
    console.log(`[stripe] payment failed: customer=${customerId} invoice=${invoice.id}`);
  }

  await markEventProcessed(event.id);
}

function setCosmeticGrantFn(fn) { cosmeticGrantFn = fn; }
// fn(action, metadata) where action is 'provision' | 'deactivate' — wired in server.js to
// tenants.createTenant / setTenantActive. Kept as an injected fn so lib/stripe stays decoupled
// from lib/tenants (same pattern as setCosmeticGrantFn).
function setCommunityProvisionFn(fn) { communityProvisionFn = fn; }
function setFullExtensionFn(fn) { fullExtFn = fn; }

module.exports = {
  initStripe, isEnabled,
  getOrCreateCustomer, getStripeCustomerId,
  createCheckoutSession, createCommunityCheckoutSession, createExtensionSubscriptionSession, createPortalSession,
  constructEvent, handleWebhookEvent,
  setCosmeticGrantFn, setCommunityProvisionFn, setFullExtensionFn,
};
