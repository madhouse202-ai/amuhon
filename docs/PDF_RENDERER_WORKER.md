# Isolated PDF renderer worker (phase 1)

This document covers both the original local synthetic render check and the opt-in paid-order queue mode. The self-test remains isolated from Supabase, Storage, Stripe and orders. The operator reports that the additive SQL migration and its queue objects, grants, and RLS were verified on staging. On 2026-11-16 the operator also reported that the Cloud Run Job, pushed image, dedicated service account, Secret Manager configuration, private bucket, and 1 GiB temporary disk were configured, and that an empty-queue execution exited successfully. This environment did not independently inspect those cloud resources or run a paid-order job; see [`STAGING_E2E_RUNBOOK.md`](STAGING_E2E_RUNBOOK.md) for the current staging procedure. Keep the manual upload route and existing payment state transitions in place.

## What the worker does

1. In synthetic/local mode, accepts only a bounded schema-version-1 render snapshot (`jobId`, the existing bounded Aozora book snapshot, and matching preloaded work text). Queue mode instead claims a bounded snapshot from the database and accepts no order ID, URL, HTML, local path, price, or caller-declared page count.
2. Starts the built Next.js app on a private `127.0.0.1` port in a temporary runtime directory that contains the production build but no `.env` files. Child-process output is discarded and its environment is an allowlist.
3. Opens the existing `/final` page in Playwright, hands the same book and work ordering through browser storage, and blocks all non-loopback and application API requests. The one font request is fulfilled in-process with the verified pinned font bytes.
4. Requires actual Noto Serif CJK JP use through the existing CDP font inspection. The PDF is validated by `validateBodyPdf` for parseability, all-page A6 media/crop boxes, rotation, and the existing 24–496 page / 8-page-multiple rule. The page count is read from the produced PDF.
5. Opens the existing `/cover` page with that verified count, downloads the existing spread-cover PNG, and runs `validateCoverPng` (dimensions, RGB channels, 350dpi metadata, decoding, and size limits).
6. Self-test mode writes both outputs with create-only semantics to `tmp/pdf-renderer-worker/`; that directory is Git-ignored. Queue mode uploads only after both outputs pass quality gates, uses create-only private Storage paths, then commits hashes/page count through a lease-checked RPC. Logs contain only fixed stage codes and numeric quality metadata.

Customer address/contact data, payment data, Stripe credentials, Supabase credentials, Storage URLs, and upload capabilities are never passed to the renderer/browser. Queue mode necessarily supplies the order's bounded book snapshot and fetched work text to `/final` so the pages can be composed; neither is written to logs or job arguments.

## Pinned runtime and font

The container uses `mcr.microsoft.com/playwright:v1.65.0-noble` and the repository lockfile's Playwright Core 1.65.0. Playwright 1.65.0 pins Chromium 158.0.8127.18 in its browser manifest. The image tag intentionally matches the Playwright package version because Playwright warns that a version mismatch cannot locate the expected browser.

At image build time, `scripts/fetch-pinned-pdf-font.mjs` retrieves only the official Noto Serif CJK 2.003 Japanese static Regular OTF and its OFL license. It stops unless the OTF is exactly 24,573,864 bytes, starts with the OTF signature, and matches SHA-256 `D9854C7A8EF170B5A7932558856FD64EB8DE0B007CD823FED6F9F514AD2803D3`. The license must identify SIL OFL 1.1 and is copied beside the font. The binary is downloaded into the image, not the repository.

## Local checks

From the repository root:

```powershell
npm run build
npm run render:pdf-worker:self-test
```

The production build script uses Next.js' bundled webpack build explicitly. This avoids the observed Windows Turbopack internal failure while keeping the build independent of remote font fetching.

The synthetic input includes multiple ordered works and ruby. It does not fetch Aozora, connect to a database, call Storage, or contact Stripe. On Windows the local self-test uses an existing system Chrome/Edge as a development-only test browser; this does not certify the pinned Linux Chromium image. Use Docker to build the image and repeat the synthetic render when Docker is available. The smoke test renders the existing `/final` and `/cover` pages, verifies actual Noto use and the generated PDF/PNG with the normal strict validators, and writes both artifacts under the ignored `tmp/pdf-renderer-worker/` directory. Mount that directory from Windows so the files remain available after the container exits. `--network none` ensures the test container cannot contact Supabase, Stripe, Aozora, or other external services:

```powershell
docker build -f Dockerfile.pdf-renderer -t amuhon-pdf-renderer:pw-1.65.0 .
$artifactRoot = Join-Path (Get-Location) "tmp/pdf-renderer-worker"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$artifactRoot = (Resolve-Path $artifactRoot).Path
docker run --rm --network none --mount "type=bind,source=$artifactRoot,target=/app/tmp/pdf-renderer-worker" amuhon-pdf-renderer:pw-1.65.0 --self-test
if ($LASTEXITCODE -ne 0) { throw "PDF renderer container smoke test failed (exit $LASTEXITCODE)." }
$latestRender = Get-ChildItem -LiteralPath $artifactRoot -Directory -Filter "render-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latestRender) { throw "No rendered artifacts were found." }
$bodyPdf = Join-Path $latestRender.FullName "body.pdf"
$coverPng = Join-Path $latestRender.FullName "cover.png"
if (-not (Test-Path -LiteralPath $bodyPdf -PathType Leaf) -or -not (Test-Path -LiteralPath $coverPng -PathType Leaf)) { throw "The smoke test did not save both assets." }
Invoke-Item $bodyPdf
Invoke-Item $coverPng
```

The worker prints fixed stage codes, page/ruby counts, byte counts, and the artifact paths. The PDF opens in the Windows default viewer; open `cover.png` from the same render directory to inspect the spread cover. The synthetic self-test fails before saving if its expected ruby count is zero. Confirm that the worker reports `WORKER_JOB_SUCCEEDED`, a positive ruby count, and `APP_SERVER_STOPPED`. The automated gate covers actual Noto font use, A6 dimensions, allowed page count, and cover dimensions/RGB/350dpi/decoding. Visual text encoding, ruby placement, TOC contents/order, and overall appearance still require opening the PDF and PNG; the smoke test does not claim subjective visual approval.

## Paid-order queue (implementation present; not deployed)

`20261115000200_order_pdf_render_jobs.sql` adds a **separate** queue for post-payment rendering. It does not reuse `amuhon_order_validation_jobs`, change the webhook's payment decision, backfill already-paid orders, change a payment state, or make an order payable. A transition to `paid` inserts one queue row in the same database transaction as the paid update. Duplicate webhook events do not create additional rows. Existing paid orders are intentionally not queued by this migration.

The queue worker is `node --experimental-strip-types scripts/render-order-assets-worker.mjs --run-queue-once`. It is gated to a production Node process, the pinned Playwright browser mode, and an explicit queue enable flag. Before any network request it requires a valid `SUPABASE_SECRET_KEY`, HTTPS Supabase URL, and `AMUHON_PDF_QUEUE_PROJECT_REF` whose exact `${ref}.supabase.co` host matches that URL. The secret is kept in the worker process only and sent as `apikey`; it is not passed to the isolated Next.js child process, browser, job arguments, or logs. The worker accepts no order ID, URL, HTML, or file path from a caller.

For one job, the worker claims a paid, already-file-verified order through the service-only claim RPC. The database returns only its bounded book snapshot, expected page count, order UUID, and lease UUID. The worker resolves works through the existing `/api/aozora` route, whose URL guard accepts only HTTPS Aozora hosts and the existing `/cards/` snapshot contract. It reuses `/final`, `/cover`, Noto Serif CJK JP 2.003 and the strict PDF/PNG validators. The new render must match the order's exact existing page count (24–300, in 8-page units). A mismatch or quality failure never reaches Storage or the commit RPC.

After both outputs pass, the worker uploads with `x-upsert: false` to the existing private `amuhon-order-files` bucket under `${orderId}/${leaseId}/body.pdf` and `cover.png`. The complete RPC locks the paid order and job, checks the unexpired current lease, requires both exact paths/hashes/size limits, and atomically replaces only the asset metadata and job state. It does not alter payment, price, or fulfillment. The old verified objects are not automatically deleted; partially uploaded or superseded private objects can remain as private storage orphans. Cleanup is deliberately not attempted when commit status is ambiguous.

Lease duration is bounded to 30 minutes; the database enforces at most five attempts. Transient Aozora, Storage, timeout, and worker failures are retried through the queue on a later execution. Invalid snapshots, invalid render output, or page-count mismatch become terminal failures. If the complete RPC response is lost, the worker reports an uncertain result and leaves the database lease authoritative; it does not mark the job failed or delete files. Failed regeneration leaves the original verified files and paid order intact.

The admin order detail page calls the new render-status RPC only after `requireAdmin()`. If the migration is absent or the RPC is unavailable, the normal admin detail remains available and render status is shown as unavailable. This status call does not expose private object keys, URLs, or customer data.

## Cloud Run status and operator-controlled execution

The earlier local implementation work did not create or change cloud resources. As of 2026-11-16, the operator reports that the staging Cloud Run Job, Artifact Registry image, dedicated service account, Secret Manager setting, private bucket, and 1 GiB temporary disk are configured, and that an empty-queue execution exited successfully. Those cloud settings and the uploaded image digest were not independently inspected in this environment. No paid-order Cloud Run generation has yet been verified. Use [`STAGING_E2E_RUNBOOK.md`](STAGING_E2E_RUNBOOK.md) for the current preflight and one-order procedure; do not repeat the old job-creation steps below for an existing Job.

The following are ongoing operating recommendations, not a claim that the resources were configured here:

- One task per execution and parallelism 1. Start with one Cloud Scheduler trigger hourly at minute 35; each execution claims at most one job. Cron `*/35 * * * *` is not a constant 35-minute interval (it alternates 35 and 25 minutes), so do not use it for lease timing. No public HTTP dispatcher is required.
- A dedicated Cloud Run Job service account with access only to read the worker secret and invoke the required APIs. Store `SUPABASE_SECRET_KEY` in Secret Manager; inject it only into the job. Set `SUPABASE_URL`, `AMUHON_PDF_QUEUE_PROJECT_REF`, and `AMUHON_PDF_QUEUE_ENABLED=true` in the job configuration. Keep `AMUHON_PDF_WORKER_BROWSER_MODE=pinned`, use the image's pinned font path, and do not pass order/customer data as arguments.
- A separate Cloud Scheduler identity permitted to execute that one Cloud Run Job. Set Cloud Run task retries to 0 initially; database lease/retry state is authoritative and the next scheduled execution retries eligible jobs.
- Set a bounded task timeout above the worker's worst-case source fetch plus 180-second Chromium render (initially 20 minutes), with CPU/memory measured using a long book. Set Cloud Run task retries and Cloud Scheduler retries to 0 initially; database lease/retry state remains authoritative. The hourly poll is later than the 30-minute DB lease even after a 20-minute task timeout, so it can reclaim a lease left by forced termination. Cloud Run `parallelism=1` limits tasks inside one execution; it is not a global per-order lock. The database claim RPC remains authoritative if executions overlap or a trigger is delivered more than once. Increase polling only after deciding the queue latency and cost are acceptable. Keep logs to fixed status codes and aggregate quality numbers.
- Configure Cloud Monitoring log-based alerts for the fixed failure codes `PDF_QUEUE_TERMINAL_FAILURE`, `PDF_QUEUE_FAILURE_RECORDING_PENDING`, `PDF_QUEUE_FINALIZATION_UNKNOWN`, `PDF_QUEUE_CLAIM_FAILED`, and `APP_SERVER_STOP_UNCONFIRMED`. The admin order page remains the source for the current job state; alerts should contain only those fixed codes and not log payloads.
- Budget monitoring for Cloud Run CPU/memory execution time, Artifact Registry storage, Cloud Scheduler, Secret Manager, and any outbound network/logging charges. Costs depend on region, resource sizing, execution duration and schedule; no fixed total is asserted here. A billing budget alert is notification only unless a spend-cap feature is explicitly configured.

Cloud Run's `parallelism` controls simultaneous tasks within one job execution, while each task runs as its own container. Cloud Scheduler may retry trigger delivery according to its retry policy, so database-side row locks and the unique `order_id` queue key are still required for idempotency. See [Cloud Run job parallelism](https://docs.cloud.google.com/run/docs/configuring/parallelism), [Cloud Run job execution model](https://docs.cloud.google.com/run/docs/resource-model), and [Cloud Scheduler delivery and retries](https://docs.cloud.google.com/scheduler/docs/overview).

Before operating on paid orders, verify that the staging project ref supplied to the job is the intended staging project and that the private bucket is still private. Do not backfill already-paid staging orders with ad hoc SQL. This task did not create a payment, access Supabase, run a job, or perform a cloud deployment.
