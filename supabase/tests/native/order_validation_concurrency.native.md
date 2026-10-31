# Native PostgreSQL concurrency test

This procedure uses a dedicated guarded wrapper and fixed SQL templates. It is
kept separate from `test-order-validation-native.ps1 -Test both`; the ordinary
rollback-only test path is unchanged. Do not invoke these SQL templates with a
manually assembled `psql` command.

See `docs/ORDER_VALIDATION_NATIVE_POSTGRES_TESTS.md`, section “Two-session
concurrency test”, for the complete guarded procedure. The wrapper repeats the
existing live-cluster preflight before each session, fixes the host/database/
role, clears libpq override variables, validates the connection inside each
SQL template, and uses generated synthetic IDs recorded in a non-secret
manifest outside the repository.

The test commits only its two synthetic orders, attempts and jobs so that a
second session can see the target. Each holder transaction rolls back. A
successful probe commits only its lock-kind evidence to the marked synthetic
decoy order after checking the active transaction, the expected relation lock,
an exact-row `FOR UPDATE NOWAIT` conflict, the null targeted-claim result, and
unchanged target/decoy jobs. The holder uses a separate top-level
`SELECT pg_catalog.pg_sleep(120)` after the lock-acquiring `DO` block; both are
on the same psql connection and open transaction, so the row lock remains held.
The probe does not match `pg_stat_activity.query` text. After the lock probes,
a successful targeted claim is committed for the synthetic target so duplicate
claiming can be checked; the explicit cleanup action removes only the exact
marked fixture rows after verifying all IDs, relations and expected states.
The claim SQL verifies the three committed database evidence markers itself;
the editable manifest is not accepted as proof. Never use the global claim,
cleanup RPCs, Storage, or cluster-wide deletion/reinitialization.
The probes exercise the targeted RPC's `FOR UPDATE SKIP LOCKED` behavior for
the order, attempt, and job rows independently.

The test uses two PowerShell windows for each lock kind (`order`, `attempt`,
`job`). A holder session has a bounded 120-second lock window; run the matching
Probe in the second window promptly. A failed or ambiguous run leaves its
manifest in `needs_review` or its last completed state. Inspect `Status` first;
use explicit `Cleanup` only when the wrapper's exact synthetic-marker checks
pass and no other client session is connected to the test database. If any guard refuses or the fixture state is unexpected, stop and do not
edit/delete rows manually.
