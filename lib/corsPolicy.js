// ONE CORS policy, shared by Express and Socket.IO so the two transports cannot drift.
// Extracted from server.js (2026-07-27 audit) so it can be unit-tested — see corsPolicy.test.js.
//
// Allowlisted site origins get credentialed CORS (cookie sessions); browser-extension origins are
// reflected WITHOUT credentials (security audit 2026-07-18 #6). The extension authenticates by
// HMAC Bearer token, never cookies, so dropping Allow-Credentials for chrome-/moz-extension://
// origins stops a *malicious* extension riding a user's session cookie via the reflection, while
// the CommunityHunts extension keeps working.
//
// The `cors` package treats a function as an options delegate, and engine.io passes its `cors`
// option straight to it (`require("cors")(this.opts.cors)`), so one delegate serves both.

const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\//;

function makeCorsPolicy(allowedOrigins) {
  const allowed = [...new Set(allowedOrigins || [])];

  function corsOrigin(origin, callback) {
    // No Origin at all: server-to-server, OBS browser sources, plain <img> loads. Always fine.
    if (!origin || allowed.includes(origin)) return callback(null, true);
    // Browser-extension requests send Origin: chrome-extension://<id>. Allow the scheme — the id
    // is unstable for unpacked installs so it can't be hardcoded, and these calls are Bearer-authed.
    if (EXTENSION_ORIGIN.test(origin)) return callback(null, true);
    // REFUSE, don't ERROR. Calling back with an Error propagates into Express's error handler, so
    // a routine disallowed origin returned 500 (not 403) and logged a stack for every request.
    // That was live: /api/img-proxy 500s from Origin: https://rainbet.com (the extension), and it
    // is why Vercel PREVIEW deploys look permanently signed out — their *.vercel.app origin isn't
    // allowlisted, so even GET /auth/me 500s. `false` is the conventional refusal: no
    // Access-Control-Allow-Origin header, browser blocks the response, no stack, no 500.
    //
    // To make a specific preview deploy work, add its URL to EXTRA_ORIGINS on Railway. Do NOT
    // blanket-allow *.vercel.app — anyone can deploy there, and these origins get credentials.
    return callback(null, false);
  }

  function corsDelegate(req, callback) {
    const origin = (req && req.headers && req.headers.origin) || '';
    const isExtension = EXTENSION_ORIGIN.test(origin);
    callback(null, { origin: corsOrigin, credentials: !isExtension });
  }

  return { corsOrigin, corsDelegate, allowedOrigins: allowed };
}

module.exports = { makeCorsPolicy };
