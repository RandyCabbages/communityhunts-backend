# Restore drill

PITR has been on since **2026-07-28 ~02:23 UTC**. Nobody has ever performed a restore, so the
recovery path is *configured*, not *proven* — and the two are not the same thing. This is the
procedure that turns one into the other, plus the measurement it produces.

Run it once now, and again after any change to the Postgres service or its image.

## What you get out of it

- A **yes/no** on whether the archive actually rebuilds the database.
- A measured **RTO** — how long from clicking restore to a queryable database.
- A record of what "restored correctly" means, so the next person doesn't have to invent it.

## Safety

Railway's PITR restore **provisions a brand-new sibling service and never touches the source.**
Production keeps serving the whole time. Both modes of the verify script are read-only (no DDL,
no DML), and it prints only counts, sums, timestamps and hashes — no names, Discord ids or
secrets. There is no step here that can damage production.

The one genuinely destructive button in this area is the **volume** backup restore
(`volumeInstanceBackupRestore`), which restores *into an existing volume*. That is not part of
this drill. Don't reach for it.

## Procedure

### 1. Baseline the source

```bash
railway run --service Postgres node scripts/restore-drill-verify.js --baseline > drill.json
```

It prints the timestamp to restore to (`restoreTarget`, deliberately ~2 minutes in the past so a
hunt archived in the same second can't land on different sides of the boundary in the two runs).

### 2. Restore

Railway dashboard → **Postgres** → **Backups** → PITR section → enter the `restoreTarget` from
step 1 → **Restore to this moment**. There is no public API for this; it is a dashboard action.

**Note the wall-clock time you click it.** That is the start of the RTO measurement.

Railway creates `Postgres-restored-YYYYMMDD-HHMM` with an empty volume, and on first boot the
image runs `pgbackrest restore --type=time --target=<T>` — base backup first, then archived WAL
replayed forward to the target, then promote.

### 3. Verify the fork

Once it's online:

```bash
railway run --service Postgres-restored-YYYYMMDD-HHMM \
  node scripts/restore-drill-verify.js --compare drill.json
```

Exit 0 = verified, exit 1 = the restore did not reproduce the source. **Record the elapsed time
from step 2** — that is the RTO, and it is the number to quote when someone asks how long an
outage would last.

### 4. Tear down

Delete the restored service **and its volume**. It bills like any other service for as long as it
exists.

## What is actually asserted, and why

The source keeps taking writes while the fork is built, so raw table counts differ between the two
and asserting equality on them would fail a perfectly good restore. The load-bearing assertion is
on the set that *cannot* legitimately change: **archived hunts with `archived_at <= restoreTarget`.**
An archived snapshot is immutable once written, so that set must come back byte-identical.

| Check | Assertion |
|---|---|
| archived-hunt row count at target | exact |
| archived-hunt content checksum | exact — md5 per row, ordered, hashed together |
| total won across those hunts | exact |
| total equity staked across those hunts | exact |
| every expected table present | must exist |
| `hunts_rows` not empty | drift expected, **zero is not** |

The two money totals are deliberately redundant with the checksum. The checksum tells you
*something* changed; these tell you whether the part anyone would argue about changed, in units a
human can reason about.

## Known limits of the current coverage

- **The restore window starts at the first post-enable base backup.** Nothing before
  2026-07-28 is recoverable, and no drill can change that.
- **Whether a Railway *volume* backup schedule exists could not be determined via the API** —
  not through the public GraphQL surface exposed to tooling, and not through Railway's own agent.
  It is visible only in the dashboard's Backups tab. Volume backups are independent of PITR and
  worth having as belt-and-braces; check the tab while you are in there for step 2.
- The image must stay on a **major** tag (`postgres-ssl:18`, not `18.x`) — PITR does not support
  minor pinning. Verified correct on 2026-07-29.

## Railway's "WAL archive credentials may be invalid" banner

A false alarm on an idle database: it infers breakage from `archived=0`, and zero WAL segments
just means nothing has been written since the base backup. `stanza-create completed` proves the
credentials work. Do **not** click "Regenerate credentials & redeploy" — hit **Recheck** after
real hunt activity.
