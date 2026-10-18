# Order draft storage setup

The order page intentionally creates `draft` records only. It does not confirm a print-ready job, expose customer details, or start payment.

## Supabase setup

1. Create a Supabase project with PostgreSQL and Storage.
2. Apply `supabase/migrations/20261017000100_order_drafts.sql` using the Supabase migration workflow.
3. Configure these server-only environment variables in the deployment platform:
   - `SUPABASE_URL`: the project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: service-role secret; never use a `NEXT_PUBLIC_` name.
   - `ORDER_RATE_LIMIT_SECRET`: a long random secret used to HMAC the trusted client address before storing its rate-limit key.
   - `ORDER_APP_ORIGIN`: canonical application origin, e.g. `https://your-domain.example` (set it when reverse-proxy URL forwarding differs).
   - `ORDER_DRAFT_RETENTION_DAYS`: optional integer from 1 through 365; defaults to 30.
4. Configure the ingress proxy to overwrite `X-Real-IP` or the first `X-Forwarded-For` address. The app hashes the selected address and never writes the raw address to the database or logs. Without a trusted client address the API refuses to save.
5. Schedule a server-side call to `purge_expired_amuhon_order_drafts()` at an interval appropriate for the configured retention. The migration sets draft expiry; it does not create a scheduler.

The migration enables row-level security, grants no table access to browser or service REST roles, and assigns the RPCs to a no-login, `NOBYPASSRLS` executor role limited to the two order tables. It creates a private `amuhon-order-files` bucket with PDF/PNG MIME restrictions and a 60 MiB object limit, plus a bucket-scoped restrictive policy that blocks browser-role access even if another permissive storage policy exists. Only authorized server-side code should upload or retrieve objects.

The database rate limiter allows five new draft submissions per hashed client address per 15-minute window. Retries with the same idempotency key return the existing safe order identifier and status without incrementing the counter. Expired rate-limit hashes are pruned opportunistically after 24 hours. Run `supabase/tests/order_drafts.test.sql` against the isolated local Supabase database after applying migrations to verify grants, function owner attributes, constraints, idempotency, and rate limiting.

## Current boundaries

The current browser PDF/PNG outputs are downloaded directly to the user's device. The server does not yet receive or inspect those files. `declared_body_pdf_page_count` is an untrusted review hint; verified page count and storage paths remain null. Database constraints prevent a row from entering `ready_for_payment` without server-verified file paths, a validation timestamp, final page count, and finalized price. No customer-information read/list route exists.

Before real orders, implement server-side asset upload and validation, authorized administrative access, price calculation, a secure customer-data retention/deletion job, and operational monitoring. Test the migration and RPC against a non-production Supabase project before deployment.
