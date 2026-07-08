// Stripe checkout + webhook routes.
// Checkout/portal require auth; webhook uses Stripe signature verification.

const express = require('express');

module.exports = function stripeRoutes(deps) {
  const { requireAuth, stripeLib, FRONTEND_URL } = deps;
  const router = express.Router();

  router.post('/api/stripe/create-checkout-session', requireAuth, async (req, res) => {
    try {
      if (!stripeLib.isEnabled()) return res.status(503).json({ error: 'Stripe not configured' });
      const { tier, interval } = req.body || {};
      if (!tier) return res.status(400).json({ error: 'tier required' });

      const successUrl = `${FRONTEND_URL}/pricing/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${FRONTEND_URL}/pricing/cancel`;

      const result = await stripeLib.createCheckoutSession(
        req.user.id, tier, successUrl, cancelUrl,
        req.user.email || null, req.user.displayName || req.user.username,
        interval === 'year' ? 'year' : undefined,
      );
      res.json(result);
    } catch (e) {
      console.error('[stripe] create-checkout-session error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/api/stripe/customer-portal', requireAuth, async (req, res) => {
    try {
      if (!stripeLib.isEnabled()) return res.status(503).json({ error: 'Stripe not configured' });
      const returnUrl = `${FRONTEND_URL}/pricing`;
      const result = await stripeLib.createPortalSession(req.user.id, returnUrl);
      res.json(result);
    } catch (e) {
      console.error('[stripe] customer-portal error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Webhook — raw body needed for signature verification.
  // This route is mounted separately in server.js with express.raw() parser.
  router.post('/api/stripe/webhook', async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

      const event = stripeLib.constructEvent(req.body, sig);
      await stripeLib.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (e) {
      console.error('[stripe] webhook error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};
