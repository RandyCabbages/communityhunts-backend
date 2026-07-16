// The single definition of "attached to a real Discord login".
//
// Discord snowflakes are 17-19 digits today; 20 is headroom. Anything else in our id-space is
// synthetic: `manual:<name>` rows minted by the name-only path of POST /api/admin/set-rainbet-name,
// the `creator_auto`/`bean_auto` equity placeholders, or a per-row equity UUID.
//
// This exists because three near-identical copies of this rule had already drifted apart:
// statsStore used a `manual:` prefix test, resolveUserIdByName a 17-19 regex, cardRequests a 17-20
// one. Import from here rather than re-deriving it — a fourth copy is how the next bug gets in.
//
// This answers "is this id a real Discord login?" and nothing else. It is NOT the same question as
// statsStore's `isRealUserId`, which asks whether an *equity row* id is attributable (not a
// placeholder, not a per-row UUID) and deliberately accepts non-snowflakes. Don't merge the two.
const isRealDiscordId = (id) => /^\d{17,20}$/.test(String(id ?? ''));

module.exports = { isRealDiscordId };
