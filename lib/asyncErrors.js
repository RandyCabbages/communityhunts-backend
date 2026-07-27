// Route async-rejection safety net.
//
// Express 4 does NOT catch a rejected promise returned by an async route handler: the
// rejection escapes the router entirely, never reaches the global error middleware in
// server.js, and surfaces as a process-level `unhandledRejection`. Node >= 15 terminates
// the process on that by default — so a single Postgres blip or a Discord 429 inside any
// `async (req, res) => {}` handler took the whole API down, dropping every connected user
// until Railway restarted us. 21 of our 81 async handlers had no try/catch, including
// /auth/me (every page load) and PUT /api/my-hunt (every 500ms during a live hunt).
//
// Patching Layer.handle_request once here fixes all of them AND every handler written
// later — the alternative (hand-wrapping each handler) leaves new code exposed and the
// bug quietly returns. This is the same approach the `express-async-errors` package takes;
// inlined rather than added as a dependency because it is ~15 lines and we want the
// reasoning above to live in the repo.
//
// Express 5 does this natively. Delete this file when we upgrade.

module.exports = function installAsyncErrors() {
  let Layer;
  try {
    Layer = require('express/lib/router/layer');
  } catch (e) {
    // Never let a hardening measure be the thing that breaks startup.
    console.error('[asyncErrors] could not patch Express Layer — async rejections stay unguarded:', e.message);
    return false;
  }

  if (Layer.prototype.__chAsyncPatched) return true;

  const original = Layer.prototype.handle_request;

  Layer.prototype.handle_request = function handle_request(req, res, next) {
    const fn = this.handle;
    // Arity > 3 means an error-handling middleware (err, req, res, next) — leave those alone.
    if (typeof fn !== 'function' || fn.length > 3) return original.apply(this, arguments);

    let ret;
    try {
      ret = fn.call(this, req, res, next);
    } catch (err) {
      // Same as Express's own sync behaviour.
      return next(err);
    }
    // The only added behaviour: a returned promise that rejects becomes next(err), so it
    // lands in the global error handler and the client gets a 500 instead of a hung socket.
    if (ret && typeof ret.then === 'function') ret.then(undefined, next);
    return ret;
  };

  Layer.prototype.__chAsyncPatched = true;
  return true;
};
