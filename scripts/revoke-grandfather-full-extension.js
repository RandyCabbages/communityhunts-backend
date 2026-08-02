// scripts/revoke-grandfather-full-extension.js — one-shot, idempotent, DRY-RUN BY DEFAULT.
//
// Undoes the `POST /api/admin/grandfather-full-extension` backfill, which inserted a
// full_extension grant for EVERY row in known_users — i.e. everyone who had ever signed in,
// affiliates included. Those rows read as `admin_comp` and hand out a $14.99/mo product free,
// permanently. BE #166 stopped a community PLAN from granting the extension; it does not touch
// these rows, which are an entirely separate source.
//
//   node scripts/revoke-grandfather-full-extension.js            # report only, writes nothing
//   node scripts/revoke-grandfather-full-extension.js --apply    # execute
//
// Needs DATABASE_URL and STRIPE_SECRET_KEY. Run the dry run first and read the numbers.
//
// Who is protected: active/trialing Stripe subscribers (re-stamped to 'stripe-sub'), deliberate
// admin comps, and NULL-grantor rows. Who loses access: grandfathered users who are not paying —
// which is the point. VIPs, mods and Discord-guild VIPs are unaffected either way; they hold
// access by ROLE, not by a grant row, so revoking here cannot touch them.
//
// The partition logic lives in lib/grandfatherRevoke.js and is unit-tested. Read the trap
// documented there before changing any predicate in this file.
const { Pool } = require('pg');
const { partitionGrants } = require('../lib/grandfatherRevoke');

const APPLY = process.argv.includes('--apply');
const FEATURE = 'full_extension';
const GRANDFATHER_LIKE = 'grandfather%';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Everyone Stripe says is CURRENTLY paying for the extension, from the subscription metadata
// createExtensionSubscriptionSession sets: { feature:'full_extension', userId }.
//
// 'trialing' counts as paying because lib/stripe.js grants on active||trialing — disagreeing here
// would cut someone off mid-trial. past_due/unpaid/canceled are treated as not paying, which also
// matches what the webhook already did to them.
async function activeExtensionSubscribers() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required — without it, payers cannot be told apart');
  const stripe = require('stripe')(key);

  const ids = new Set();
  let scanned = 0;
  // The node SDK makes list() async-iterable and pages automatically.
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    scanned++;
    if (sub.metadata?.feature !== FEATURE) continue;
    if (sub.status !== 'active' && sub.status !== 'trialing') continue;
    if (sub.metadata?.userId) ids.add(String(sub.metadata.userId));
  }
  console.log(`  scanned ${scanned} Stripe subscriptions`);
  return ids;
}

(async () => {
  console.log(APPLY
    ? '=== APPLY — this WRITES to feature_grants ===\n'
    : '=== DRY RUN — nothing is written. Re-run with --apply to execute. ===\n');

  const { rows } = await pool.query(
    'SELECT discord_id, granted_by FROM feature_grants WHERE feature_key=$1', [FEATURE]);

  // Partition once with no payer set, just to report the shape of the table.
  const shape = partitionGrants(rows);
  console.log(`feature_grants rows for ${FEATURE}: ${rows.length}`);
  console.log(`  grandfathered : ${shape.grandfathered.length}   <- revocation candidates`);
  console.log(`  stripe-sub    : ${shape.stripeRows.length}   (already correctly attributed)`);
  console.log(`  admin comps   : ${shape.comps.length}   (deliberate — kept)`);
  console.log(`  NULL grantor  : ${shape.ambiguous.length}   (ambiguous — LEFT ALONE, decide by hand)`);

  if (!shape.grandfathered.length) {
    console.log('\nNothing to revoke — the backfill either never ran or has already been undone.');
    await pool.end();
    return;
  }

  console.log('\nAsking Stripe who is actually paying...');
  const payers = await activeExtensionSubscribers();
  console.log(`  ${payers.size} active/trialing full_extension subscriber(s)`);

  const { atRisk, toDelete } = partitionGrants(rows, payers);

  console.log(`\n  ${atRisk.length} grandfathered row(s) belong to ACTIVE PAYERS`);
  console.log('    -> re-stamped to stripe-sub: access preserved, billing unaffected');
  if (atRisk.length) console.log('    ' + atRisk.map(r => r.discord_id).join(', '));
  console.log(`  ${toDelete.length} row(s) to REVOKE (free access, not paying)`);

  if (!APPLY) {
    console.log('\nDry run complete — nothing written.');
    await pool.end();
    return;
  }

  // Re-stamp BEFORE deleting, in one transaction. Once a payer's row reads 'stripe-sub' it no
  // longer matches the delete predicate, so the delete cannot get ahead of the protection.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let restamped = 0;
    if (atRisk.length) {
      const r = await client.query(
        `UPDATE feature_grants SET granted_by='stripe-sub'
          WHERE feature_key=$1 AND discord_id = ANY($2::text[])`,
        [FEATURE, atRisk.map(x => String(x.discord_id))]);
      restamped = r.rowCount || 0;
    }

    const del = await client.query(
      `DELETE FROM feature_grants
        WHERE feature_key=$1 AND granted_by IS NOT NULL AND granted_by LIKE $2`,
      [FEATURE, GRANDFATHER_LIKE]);

    await client.query('COMMIT');
    console.log(`\nre-stamped ${restamped} payer row(s) to stripe-sub`);
    console.log(`revoked    ${del.rowCount || 0} grandfathered row(s)`);
    console.log('\nNOTE: the running server caches grants in memory (lib/featureGrants.js).');
    console.log('REDEPLOY so reloadGrantCache picks this up — until then nothing changes for users.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('\nrolled back — no changes were made');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
