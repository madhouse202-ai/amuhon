# Native PostgreSQL isolated tests for order validation

This test path is for a manually provisioned, disposable Windows-native
PostgreSQL cluster only. It is not a Supabase emulator. It must never connect to
`amuhon` or `amuhon-staging`; neither endpoint is used by these procedures.

The PowerShell runner only inspects the already-running cluster and executes
the two native SQL test files. It does not initialize, start, stop, migrate,
reset, delete, or drop a database. No database or PostgreSQL software was
installed or contacted as part of preparing this harness.

## What this validates

- SQL behavior of the targeted-claim and atomic asset-commit RPCs against
  synthetic rows in PostgreSQL.
- Selected RLS, grants, function owner, `SECURITY DEFINER`, and fixed
  `search_path` metadata.
- Transaction rollback of test fixtures and expected RPC outcomes.
- A manually provisioned mock `storage` schema sufficient for migration
  references. The mock is not Supabase Storage and provides no assurance about
  Storage API, JWT, bucket enforcement, signed uploads, or Storage RLS runtime.

It does not prove Supabase-specific role behavior, hosted PostgreSQL settings,
Storage semantics, Edge Functions, network policies, or production safety.

## Directory layout

Keep the ZIP distribution, cluster data, logs and identity file outside this
repository. Example only; create these paths manually after separately
reviewing and obtaining PostgreSQL binaries:

```text
C:\amuhon-native-pg\
  pgsql\               # trusted EDB ZIP directory; keep its internal layout intact
    bin\               # PostgreSQL executables used by the guarded wrappers
    share\             # other ZIP contents remain alongside bin as provided
  cluster\             # disposable PGDATA
  logs\
  identity\
    native-cluster.json
```

The project repository contains only the SQL fixtures, PowerShell inspection
runner and static tests. Do not place `PGDATA` or logs in the repository.
All three guarded wrappers resolve executables only from `NativeRoot\pgsql\bin`;
they do not fall back to the former `NativeRoot\bin` layout. Keep the ZIP tree
in place and do not move the running binaries or the `cluster` directory.

## Manual provisioning (not performed by the runner)

1. Obtain and verify a Windows PostgreSQL ZIP distribution independently.
   The runner accepts matching server/client majors 15–18; check the exact
   migration compatibility before choosing a version.
2. Create the example directories yourself. Initialize only the dedicated
   cluster using the trusted `initdb.exe`, with SCRAM for both host and local
   authentication, and set a password interactively (for example, the reviewed
   EDB binary's `initdb.exe -D C:\amuhon-native-pg\cluster -U postgres
   --auth-host=scram-sha-256 --auth-local=scram-sha-256 -W`). Never use
   `trust` or put the password in a command line, script, JSON file,
   environment variable, or log. Do not register a Windows service.
3. Configure the cluster with `listen_addresses = '127.0.0.1'`, `port = 55432`,
   and `cluster_name = 'amuhon-native-order-validation-v1'`. Configure
   `pg_hba.conf` to contain exactly these four active rules, in this order:

   ```text
   host postgres postgres 127.0.0.1/32 scram-sha-256
   host amuhon_validation_native postgres 127.0.0.1/32 scram-sha-256
   host all all 127.0.0.1/32 reject
   host all all ::1/128 reject
   ```

   The first two rules permit SCRAM only for the named local databases and
   `postgres` role; the final rules reject every other IPv4-loopback and IPv6
   host connection. There must be no additional active authentication rule,
   `include`, `include_if_exists`, or `include_dir` directive. The shared
   preflight checks the normalized active lines and their order exactly, so
   unexpected rules, include-based paths, and Unix-socket `local` rules are
   refused. The runner itself connects only to IPv4 loopback.
4. Manually start this cluster only after checking its data path and config.
   Create the dedicated database `amuhon_validation_native` yourself over the
   fixed loopback TCP connection. No runner action performs these steps.
5. Record the cluster system identifier from `pg_controldata`, canonical
   `cluster` directory, Windows owner, fixed port/database/cluster name in
   `identity\native-cluster.json`. The file must have this shape and contain
   no credentials:

   ```json
   {
     "schemaVersion": 1,
     "purpose": "amuhon-native-order-validation-only",
     "database": "amuhon_validation_native",
     "port": 55432,
     "clusterName": "amuhon-native-order-validation-v1",
     "dataDirectory": "C:\\amuhon-native-pg\\cluster",
     "systemIdentifier": "REPLACE_WITH_PG_CONTROLDATA_VALUE",
     "osOwner": "REPLACE_WITH_CURRENTDOMAIN\\CURRENTUSER"
   }
   ```

   The system identifier is not a secret. Never copy a Supabase database URL or
   hosted project identifier into this file.
6. Apply the bootstrap only through its guarded wrapper. **Do not run
   `bootstrap.sql` directly with `psql` or SQL Editor.** The wrapper calls the
   same full live-cluster preflight as the test runner, clears libpq connection
   environment overrides, fixes the loopback host, port, database and role,
   then starts one psql session. In that same session, the SQL checks the
   expected data directory and cluster system identifier before creating any
   cluster-global roles. The wrapper substitutes a fresh, one-run nonce into
   a temporary snapshot; the checked-in SQL placeholder therefore fails if
   someone runs the source file directly. The bootstrap also rejects extra
   databases, roles, schemas, public relations, routines and user-defined
   types visible in the dedicated target database. Supply the
   existing identity file's NativeRoot; do not substitute a URL or connection
   string:

   ```powershell
   .\scripts\native-postgres\apply-order-validation-native-bootstrap.ps1 -NativeRoot C:\amuhon-native-pg
   ```

   Enter the password only at the prompt. If any preflight or SQL check fails,
   stop. Do not bypass the wrapper or continue to migration application.
   The nonce is a guard against accidental direct invocation, not a boundary
   against a local administrator who can modify the scripts or PostgreSQL
   process environment. The wrapper deliberately connects only to the fixed
   test database for bootstrap DDL; it checks the cluster database-name and
   global-role allowlists from that connection.
7. Apply migrations only through the guarded native wrapper. Do not paste
   migration SQL into SQL Editor or call `psql -f` manually. The wrapper
   invokes the same live cluster preflight as the test runner, fixes host,
   port, database and role, snapshots the exact seven migration files outside
   the repository, compares each file with its reviewed SHA-256 allowlist and
   checks transaction compatibility, and
   applies them in the listed order in one `psql -1` transaction. It records
   version and SHA-256 in the native-only ledger. A prior ledger entry,
   partial/prior schema, failed check, or hash mismatch stops before apply.
   If the wrapper reports failure, stop. Do not manually apply a subset or
   rerun individual files. A clean transaction rollback leaves the ledger
   empty; an uncertain client result after commit is detected by the ledger
   and requires review rather than replay.

   ```powershell
   .\scripts\native-postgres\apply-order-validation-native.ps1 -NativeRoot C:\amuhon-native-pg
   ```

   The wrapper does not initialize, start, stop, drop, reset, or delete a
   database. Its migration snapshots are temporary files outside the
   repository.

### Migration order

1. `20261017000100_order_drafts.sql`
2. `20261020000100_order_asset_uploads.sql`
3. `20261020000200_order_asset_size_limit.sql`
4. `20261020000300_order_temp_uploads.sql`
5. `20261021000100_order_validation_jobs.sql`
6. `20261022000100_order_validation_asset_commit.sql`
7. `20261025000100_order_validation_targeted_claim.sql`

This list is based on the current repository dependency order, not on a tested
fresh-cluster migration run. Each digest below is SHA-256 of the exact current
file bytes. These are the reviewed allowlist used by the migration wrapper;
any migration edit makes the wrapper stop until a separate review updates the
allowlist and documentation.

| Migration | Approved SHA-256 |
| --- | --- |
| `20261017000100_order_drafts.sql` | `1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69` |
| `20261020000100_order_asset_uploads.sql` | `6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538` |
| `20261020000200_order_asset_size_limit.sql` | `ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33` |
| `20261020000300_order_temp_uploads.sql` | `5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e` |
| `20261021000100_order_validation_jobs.sql` | `8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995` |
| `20261022000100_order_validation_asset_commit.sql` | `28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d` |
| `20261025000100_order_validation_targeted_claim.sql` | `194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de` |

The mocked `storage` schema is deliberately
incomplete compared with Supabase; a migration failure due to a missing
Supabase-specific dependency means this native path cannot validate that part.
The migration wrapper requires the pristine post-bootstrap database and applies
this exact seven-file list once. It is not a migration manager for existing
databases, Supabase projects, or partial manual application.

## Run only the native tests

After manually provisioning the cluster, running the bootstrap, and applying
the guarded migration batch, open PowerShell in the repository and run:

```powershell
.\scripts\native-postgres\test-order-validation-native.ps1 -NativeRoot C:\amuhon-native-pg -Test both
```

The script accepts a local filesystem root and a test selector only; it has no
database URL argument. It checks canonical paths and reparse points, identity
JSON, PG_VERSION, `pg_controldata` system identifier, `pg_ctl status`, PID file,
process executable/command line/Windows owner, absence of Windows service
ownership, the sole IPv4-loopback listener on port 55432, and live database
reported identity/config/system ID. `pg_controldata` output is accepted only
when exactly one English or Japanese system-identifier label is decoded and
its decimal value matches the identity file; missing, duplicated, malformed,
or garbled output is rejected. The source uses ASCII regex escapes for the
Japanese label so Windows PowerShell 5.1 does not depend on script-file Unicode
decoding. If PowerShell cannot decode the executable's output into the known
label, preflight fails closed. It refuses to proceed if any check is unknown
or mismatched. PostgreSQL identity variables are scoped to the child process
and restored afterward. The password is prompted by `psql -W`.

The process command line is parsed using Windows `CommandLineToArgvW` rules.
The runner requires argv[0] to resolve exactly to the expected `postgres.exe`
and exactly one standalone `-D` whose following argument resolves exactly to
the expected data directory. Canonical path comparison handles `/` versus `\\`
and case differences. Substring matches, `-Dpath`, `--pgdata`, duplicate `-D`,
UNC paths, and ambiguous command lines are rejected.

The runner uses `psql -X` and `ON_ERROR_STOP=1`; it does not pass a connection
URL, `PGPASSWORD`, or credentials as arguments. A SQL failure exits the psql
process, closing its connection so PostgreSQL rolls back the open test
transaction. The tests use synthetic records inside one transaction and end
with `ROLLBACK`; they do not call global claim, cleaner, Storage, or deletion
RPCs.

Run the static source checks without PostgreSQL:

```powershell
node --test tests/order-validation-native-runner.test.mjs
```

Static checks do not execute or parse SQL with PostgreSQL and do not prove the
runner's environment checks against a live Windows process. Do not describe
them as database integration-test success.

## Two-session concurrency test

The separate concurrency harness is not included in `-Test both`. It creates
two fresh synthetic orders, two upload attempts, and two validation jobs so
the targeted claim can be checked for a locked target and accidental fallback
to a decoy. Fixture setup commits because another session must see those rows.
Each lock-holder transaction rolls back after its bounded wait. A successful
probe commits only a per-run `native_lock_probes` marker to the synthetic decoy
order after verifying the actual lock, the null targeted-claim result, and the
unchanged target/decoy jobs. This small synthetic-only commit lets a later
session independently verify which probes actually passed.
After locks are released, the harness commits one targeted claim for the
synthetic target, checks a duplicate claim returns no job, then requires an
explicit exact-ID cleanup action. It never uses global claim, cleanup RPCs,
Storage, or cluster reset/deletion.

Use Windows PowerShell 5.1. The only accepted endpoint/database/role are
`127.0.0.1:55432`, `amuhon_validation_native`, and `postgres`. Every action
invokes the existing native runner's `-PreflightOnly`; each SQL session also
checks the database, client/server IPv4 addresses, port, data directory,
system identifier, cluster name, application name, and per-run marker. The
wrapper clears inherited libpq overrides and accepts no DB URL, SQL path,
host, port, or role argument. Password entry remains interactive; no password
is saved in scripts, arguments, manifest, or log.

Prepare once:

```powershell
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Prepare
```

Copy the printed `RunId` (it is not a credential). For each of `order`,
`attempt`, and `job`, use two PowerShell windows. In window A, start the lock
holder; while its fixed 120-second window is open, run the matching probe in
window B. Each wrapper action prompts twice: once for its shared read-only
preflight connection and once for the action's own psql connection. Enter the
password only in those prompts:

```powershell
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Hold -LockKind order -RunId <RUN_ID>
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Probe -LockKind order -RunId <RUN_ID>
```

Repeat with `-LockKind attempt` and `-LockKind job`. The probe checks that the
matching holder session is active in a transaction, then tries `FOR UPDATE
NOWAIT` on the exact requested synthetic row. It requires the attempt to fail
with a row-lock conflict before calling only
`claim_amuhon_order_validation_job_for_attempt`. It requires a null result,
an unchanged queued target, and an unchanged queued decoy. Only after all
checks pass does it commit the probe kind to the exact marked decoy order.
The holder keeps its row lock across the `DO` block and a separate top-level
`SELECT pg_catalog.pg_sleep(120)` because both execute on the same psql
connection and open transaction. Holder detection does not depend on the
possibly truncated `pg_stat_activity.query` text. A failure or timeout is a
failed test; do not rerun the probe after its holder ends and call that a pass.

After all three pairs finish, run the release/claim check, inspect the run,
then explicitly clean the synthetic rows:

```powershell
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action ClaimAfterUnlock -RunId <RUN_ID>
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Status -RunId <RUN_ID>
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Cleanup -RunId <RUN_ID> -ConfirmSyntheticCleanup
```

If guarded Cleanup stops with a psql error and its original error text is no
longer available, do not rerun Prepare or Cleanup to investigate. Use the
separate read-only Diagnose action with the existing RunId:

```powershell
.\scripts\native-postgres\test-order-validation-concurrency-native.ps1 -NativeRoot C:\amuhon-native-pg -Action Diagnose -RunId <RUN_ID>
```

Diagnose uses the same native preflight, manifest UUIDs, fixed SQL-template
path, and in-SQL cluster identity guard. It reports each Cleanup predicate as
a condition name, PASS/FAIL result, and count without printing object keys or
personal data. It begins a `READ ONLY` transaction only after the identity
guard, then rolls it back. It does not acquire an advisory lock, change the
fixture or manifest, or call Cleanup. An advisory-lock row count, if reported,
is only a point-in-time observation. Diagnose does not guarantee that a later
Cleanup will succeed: sessions and fixture state can change after its query.
The wrapper writes a non-secret generated SQL snapshot under this RunId's
existing local run directory; it does not update `manifest.json`.

`ClaimAfterUnlock` does not trust the manifest's `completedLocks` JSON as
proof. Its SQL requires exactly three committed probe markers (`order`,
`attempt`, `job`) on this run's exact synthetic decoy order. Editing the
manifest cannot bypass this database check. The wrapper stores the generated
run manifest and fixed SQL snapshots under
`NativeRoot\logs\order-validation-concurrency\runs\<RunId>`; they contain no
credentials. It refuses a new prepare if an earlier manifest is not marked
cleaned or a marked fixture remains in the database. Cleanup verifies the two
order markers, exact order/attempt relations, object-key shape, job states,
and absence of any other client session in the test database before deleting
only those exact two jobs, two attempts, and two marked orders in one
transaction. If any check fails, the transaction rolls back. The manifest
remains after cleanup as a non-secret operational record. Status reports
`fixture_not_present`, `fixture_in_progress`,
`claim_committed_cleanup_pending`, `fixture_inconsistent_stop`, or
`cleanup_completed` when no fixture rows remain and the manifest records a
successful cleanup. The latter label uses the manifest only to distinguish a
completed cleanup from a run that never created fixtures; it does not
authorize claim or cleanup.

Every session has `lock_timeout=3s`; probe and claim SQL have a 15-second
timeout, setup/cleanup 20 seconds, and the lock holder sleeps 120 seconds
under a 160-second SQL timeout and 180-second process watchdog. A run has a
30-minute action window; status and guarded cleanup remain available after
that. If a client is terminated, PostgreSQL closes its session and rolls back
the open transaction. Committed setup/claim fixtures remain until explicit
cleanup, so after interruption inspect `Status` and then use only guarded
cleanup. Do not manually delete rows or discard/reinitialize the cluster.

This is operator-coordinated rather than an automatically orchestrated
two-session process. It has not been run against PostgreSQL as part of this
change. PowerShell console inheritance for the interactive `psql -W` prompt
and the SQL behavior must be verified in the dedicated native cluster before
relying on it. Setup and Cleanup run their identity guard as the first SQL
statement. Only after it succeeds do they begin a transaction and acquire the
fixture-serialization advisory lock. Never use `amuhon` or `amuhon-staging`.

## Stop conditions and cleanup

Stop if the runner refuses any check, the server is not already running, the
system identifier differs, the port has any other owner/address, database
identity differs, the role or test marker differs, or SQL fails. Do not bypass
the guard, substitute a connection string, or point the script at a Supabase
endpoint. Do not repair a failed run by deleting arbitrary rows. For a
concurrency fixture, use only its `Status` and explicitly confirmed guarded
`Cleanup` actions; if identity/state checks fail, stop and request review. The
runner never stops or deletes the cluster.

No live PostgreSQL execution has been performed as part of this implementation.
