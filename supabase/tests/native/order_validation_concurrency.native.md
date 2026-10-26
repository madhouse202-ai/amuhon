# Native PostgreSQL concurrency test (manual design)

This is a procedure note, not an executable test. A single SQL file cannot safely
hold a row lock in one transaction while a second session tests `SKIP LOCKED`.
The automated native runner deliberately does not start sessions or execute this
procedure.

## Preconditions

- Use only the dedicated disposable cluster described in
  `docs/ORDER_VALIDATION_NATIVE_POSTGRES_TESTS.md`.
- Never connect to `amuhon` or `amuhon-staging`.
- Confirm the same data directory, system identifier, fixed database, loopback
  endpoint, cluster marker and SCRAM-only `pg_hba.conf` in both sessions.
- Use newly generated synthetic order, attempt and job IDs. Do not use a real
  order, attempt, object key, or storage path. Do not invoke the global claim,
  cleanup, Storage, or deletion RPCs.
- This protocol requires an operator-reviewed setup query that creates only a
  queued synthetic job and commits that fixture. The transaction-local SQL
  integration tests remain rollback-only; do not weaken that property to make
  a lock visible to another session.

## Manual two-session protocol

1. Open two separate `psql` sessions against the dedicated database with
   `-X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55432 -U postgres -d
   amuhon_validation_native -W`. Apply the same verified session marker
   (`application_name` and the two `app.amuhon_native_*` settings) to both.
2. In session A, begin a transaction and lock the synthetic target rows in the
   same order as the targeted claim RPC: order, attempt, job. Keep the
   transaction open. Do not call the RPC in A.
3. In session B, call only
   `claim_amuhon_order_validation_job_for_attempt(order_id, attempt_id, 300)`.
   A safe implementation should return no job promptly while A holds the
   conflicting lock; it must not claim another order. Verify no unrelated row
   changed, then roll back B if it opened an explicit transaction.
4. Roll back session A to release its row locks. Call the targeted claim from
   B: exactly one JSON job should be returned. A second call while its lease is
   active should return no job.
5. For a separate synthetic fixture, expire the first validation lease using
   test setup in the isolated database, then claim again. The returned lease ID
   must differ. Completion with the old lease must be rejected; completion
   with the new lease is tested only through the appropriate atomic commit
   RPC and synthetic metadata.
6. Remove fixtures only by discarding/reinitializing the entire disposable
   cluster after disconnecting both sessions. Do not use a cleanup RPC or
   manual deletion as part of this procedure.

Stop immediately if either session reports an unexpected database, address,
port, cluster/system identifier, role, or if the target query returns an
unrelated job. Manual concurrency observations are not covered by the automated
static tests and must be recorded separately.
