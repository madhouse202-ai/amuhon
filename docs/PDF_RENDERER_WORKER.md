# Isolated PDF renderer worker (phase 1)

This phase adds a container-buildable renderer and a local synthetic render check. It does **not** start from an order API, access Supabase, write Storage, or make an order payable. Keep the manual upload route and current order state transitions in place.

## What the worker does

1. Accepts only a bounded schema-version-1 render snapshot (`jobId`, the existing bounded Aozora book snapshot, and matching preloaded work text). It does not accept HTML, a URL to render, a local path, a price, or a client-declared final page count.
2. Starts the built Next.js app on a private `127.0.0.1` port in a temporary runtime directory that contains the production build but no `.env` files. Child-process output is discarded and its environment is an allowlist.
3. Opens the existing `/final` page in Playwright, hands the same book and work ordering through browser storage, and blocks all non-loopback and application API requests. The one font request is fulfilled in-process with the verified pinned font bytes.
4. Requires actual Noto Serif CJK JP use through the existing CDP font inspection. The PDF is validated by `validateBodyPdf` for parseability, all-page A6 media/crop boxes, rotation, and the existing 24–496 page / 8-page-multiple rule. The page count is read from the produced PDF.
5. Opens the existing `/cover` page with that verified count, downloads the existing spread-cover PNG, and runs `validateCoverPng` (dimensions, RGB channels, 350dpi metadata, decoding, and size limits).
6. Writes both outputs with create-only semantics to `tmp/pdf-renderer-worker/`; that directory is Git-ignored. Logs contain only fixed stage codes and numeric quality metadata.

No order/customer data, Stripe credentials, Supabase credentials, object keys, or Storage URLs are passed to the renderer.

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

The synthetic input includes multiple ordered works and ruby. It does not fetch Aozora, connect to a database, call Storage, or contact Stripe. On Windows the local self-test uses an existing system Chrome/Edge as a development-only test browser; this does not certify the pinned Linux Chromium image. Use Docker to build the image and repeat the synthetic render when Docker is available:

```powershell
docker build -f Dockerfile.pdf-renderer -t amuhon-pdf-renderer:pw-1.65.0 .
```

The actual artifacts and a `PASS` result must be checked before treating the local renderer test as successful.

## Production boundary: not enabled yet

This image is not yet a production order worker. Cloud Run Jobs does not provide the stdin job contract used by the local runner, and the application has no dedicated PDF-render queue/claim lease or atomic “both generated files verified and order remains preparing” commit RPC. The current validation queue is for customer-uploaded temporary files; reusing its upload lease for generated files would blur authorization and state semantics. The order draft RPC and UI also do not enqueue a render job. Therefore:

- Do not deploy or invoke this image for customer orders yet.
- Do not change the existing draft, file validation, payment, or fulfillment state.
- The next production step is an additive migration for a separate render-job queue, exact-order claim/lease/fail/commit RPCs, and a server-only API dispatcher that invokes Cloud Run Jobs through IAM without putting order content or capability tokens in job arguments or logs.
- The worker must then claim the immutable DB snapshot itself, resolve/cache approved Aozora text on the server, validate both outputs, save to the existing private `amuhon-order-files` bucket under deterministic attempt-specific keys, and atomically record hashes/page count only if its lease is current. Until that adapter exists, generated files remain local artifacts and cannot make checkout eligible.

Recommended first deployment limits after the queue adapter is reviewed: one task per execution, concurrency/parallelism 1, bounded render timeout (worker 180 seconds; job timeout 10 minutes), small explicit CPU/memory limits measured with a full-length book, and a low Cloud Run retry count backed by the database lease/idempotency checks. Cloud Run Job retries are task-level retries; the DB lease remains authoritative. Failed generation must leave the order in `preparing` (or a dedicated retryable render-job state); it must never set `ready_for_payment`, and no automatic Storage cleanup should run while commit status is ambiguous.

Cloud/GCP project, service account, Secret Manager, Artifact Registry, deployment, Supabase changes, and Stripe operations were not performed.
