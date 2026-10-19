# Order draft storage setup

The order page intentionally creates `draft` records only. It does not confirm a print-ready job, expose customer details, or start payment.

## Supabase setup

1. Select the **`amuhon-staging`** Supabase project. Do not use the production `amuhon` project for setup or tests.
2. Apply `supabase/migrations/20261017000100_order_drafts.sql` to that staging project using the Supabase migration workflow.
3. For local development, configure these server-only variables in `.env.local`; for deployment, configure them in that environment's secret-variable settings. Obtain the URL and key only from the selected `amuhon-staging` project's Dashboard:
   - `SUPABASE_URL`: the staging project URL. Find it in the project's **Connect** dialog or **Project Settings → API**.
   - `SUPABASE_SERVICE_ROLE_KEY`: the staging project's server-side service-role/secret key, from **Project Settings → API Keys**. The current API route expects this environment-variable name. Never use a `NEXT_PUBLIC_` name or expose the value to browser code.
   - `ORDER_RATE_LIMIT_SECRET`: a long random secret used to HMAC the trusted client address before storing its rate-limit key.
   - `ORDER_APP_ORIGIN`: canonical application origin, e.g. `http://localhost:3000` locally or `https://your-staging-domain.example` in staging (set it when reverse-proxy URL forwarding differs).
   - `ORDER_DRAFT_RETENTION_DAYS`: optional integer from 1 through 365; defaults to 30.
4. Before saving the variables, verify that both URL and key are shown under **`amuhon-staging`** in the Dashboard. Do not copy either from `amuhon`.
5. Configure the ingress proxy to overwrite `X-Real-IP` or the first `X-Forwarded-For` address. The app hashes the selected address and never writes the raw address to the database or logs. Without a trusted client address the API refuses to save.
6. Schedule a server-side call to `purge_expired_amuhon_order_drafts()` at an interval appropriate for the configured retention. The migration sets draft expiry; it does not create a scheduler.

The migration enables row-level security and grants no direct table access to browser or service REST roles. Its `SECURITY DEFINER` RPCs retain the Supabase-managed `postgres` owner, use a restricted `search_path`, and grant execution only to `service_role`; the migration deliberately does not create or alter a custom executor role. It creates a private `amuhon-order-files` bucket with PDF/PNG MIME restrictions and a 60 MiB object limit, plus a bucket-scoped restrictive policy that blocks browser-role access even if another permissive storage policy exists. Only authorized server-side code should upload or retrieve objects.

The database rate limiter allows five new draft submissions per hashed client address per 15-minute window. Retries with the same idempotency key return the existing safe order identifier and status without incrementing the counter. Expired rate-limit hashes are pruned opportunistically after 24 hours. Run `supabase/tests/order_drafts.test.sql` only against the intended non-production staging project after verifying its project reference; the test includes an explicit staging confirmation guard and rolls back its test transaction. It checks grants, function owner attributes, constraints, idempotency, and rate limiting.

## Current boundaries

The current browser PDF/PNG outputs are downloaded directly to the user's device. The server does not yet receive or inspect those files. `declared_body_pdf_page_count` is an untrusted review hint; verified page count and storage paths remain null. Database constraints prevent a row from entering `ready_for_payment` without server-verified file paths, a validation timestamp, final page count, and finalized price. No customer-information read/list route exists.

Before real orders, implement server-side asset upload and validation, authorized administrative access, price calculation, a secure customer-data retention/deletion job, and operational monitoring. Test the migration and RPC against a non-production Supabase project before deployment.
