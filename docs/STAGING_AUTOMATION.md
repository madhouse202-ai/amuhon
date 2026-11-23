# amuhon staging automation handoff

Updated: 2026-11-21

This is the current operational guide for the staging PDF renderer. The older `CLOUD_RUN_HANDOFF.md` and `PDF_RENDERER_WORKER.md` describe historical setup and should not be used to recreate existing resources. This change prepares repository files only: it does not inspect or alter Cloud Build, Artifact Registry, Cloud Run, Cloud Scheduler, Secret Manager, Supabase, Storage, or Stripe.

## What the repository already does

- A transition to `paid` enqueues at most one PDF render job for that order. Existing paid orders are not backfilled.
- The worker entry point is the Dockerfile `ENTRYPOINT` plus the Cloud Run Job argument `--run-queue-once`. One execution claims at most one eligible queue row; it accepts no order ID.
- The claim RPC is the concurrency authority. It locks the order/job and uses a bounded lease. A duplicate Scheduler delivery or overlapping execution cannot claim the same live lease. `parallelism=1` alone is not a global lock.
- Queue mode revalidates the paid state, the already validated source files, rights decision, snapshot and page count; it reuses `/final` and `/cover`, Playwright 1.65.0 / its pinned Chromium, the SHA-256 checked Noto Serif CJK JP 2.003 font, and strict PDF/PNG validators.
- Both outputs are uploaded to the existing private bucket under lease-specific object keys with create-only semantics. Only the completion RPC can attach both objects to the order after hashes, sizes, lease and page count match. Failure does not change payment state or replace the previously verified files.
- The admin order detail already reports queued, rendering, succeeded, failed and unavailable states after administrator authorization.
- Paid-order email notifications use a separate private outbox and a separate Cloud Run Job/Scheduler. This worker reuses the image but overrides the PDF ENTRYPOINT with `scripts/send-order-paid-notifications-worker.mjs`; it never starts the PDF render loop or touches Storage.
- `--self-test` uses synthetic content. The Cloud Build configuration below runs it in a container with `--network=none` before any image push or Cloud Run update.

The operator reports that the staging Job, repository, runtime service account, secret reference, private bucket and 1 GiB temporary volume exist, and that an empty-queue run previously succeeded. Those facts were not independently confirmed here. Read-only `gcloud` calls in this environment could not open the local Cloud SDK credential database, so current cloud configuration, triggers, Scheduler state, IAM and image digest remain unverified.

## Build and staging deployment pipeline

`cloudbuild.staging.yaml` implements this sequence:

1. Require a Git commit SHA and the `amuhon-staging` project.
2. Run `npm ci`, the staging automation config test, ESLint, `next typegen`, TypeScript, and the order/rights/queue contract suites. `next typegen` runs before `tsc --noEmit` so generated App Router helper types such as `LayoutProps` exist in a clean build environment.
3. Build the `linux/amd64` renderer image. `Dockerfile.pdf-renderer` keeps Playwright/Chromium version pinning and the official Noto font hash check. `.dockerignore` excludes local worktrees, environment files, local assets, and generated artifacts from the image context.
4. Run the synthetic renderer self-test with networking disabled. If any prior step fails, the pipeline stops before publication.
5. With the default `_DEPLOY_STAGING=false`, stop after build and smoke test; do not push an image or update the Job.
6. A deliberately configured push trigger can set `_DEPLOY_STAGING=true`. Only the named staging branch is accepted. The pipeline checks that the existing Artifact Registry repository, PDF Job and notification Job are present, pushes an image tagged with the full commit SHA, resolves its SHA-256 digest, then updates only both existing Jobs' images and `source-commit` labels. It never executes the Jobs and does not alter arguments, environment, secret versions, identity, task settings or volume mounts.

The YAML `serviceAccount` is used for direct Cloud Build submissions. GitHub repository triggers use the service account selected on the trigger; Cloud Build ignores the YAML service account for trigger-invoked builds. The trigger must therefore explicitly select the dedicated build account and set `_DEPLOY_STAGING=true`.

Do not configure a pull-request trigger for this deployment identity. Protect the staging branch and permit only reviewed changes: a push trigger runs repository-controlled build steps using an identity that can update the staging Job. A staging deployment happens only after all tests and the offline render gate pass. Production is not a target of this pipeline.

## One-time read-only preflight

Run these in Windows PowerShell after authenticating `gcloud` to the intended account. They only describe/list resources; they do not print environment variable values, Secret Manager payloads, HTTP headers, or queue/order data.

```powershell
gcloud auth login
gcloud config set project amuhon-staging
gcloud config get-value project
gcloud builds triggers list --project=amuhon-staging --format="table(name,filename,serviceAccount)"
gcloud artifacts docker images list asia-northeast1-docker.pkg.dev/amuhon-staging/amuhon-pdf-renderer/pdf-renderer --include-tags --format="table(version,tags)"
gcloud run jobs describe amuhon-pdf-renderer --project=amuhon-staging --region=asia-northeast1 --format="json(name,labels,template.taskCount,template.parallelism,template.template.maxRetries,template.template.timeout,template.template.serviceAccount,template.template.containers[0].image,template.template.containers[0].command,template.template.containers[0].args,template.template.containers[0].env[].name,template.template.containers[0].env[].valueSource.secretKeyRef.name,template.template.containers[0].env[].valueSource.secretKeyRef.version)"
gcloud run jobs describe amuhon-order-notification-worker --project=amuhon-staging --region=asia-northeast1 --format="json(name,labels,template.taskCount,template.parallelism,template.template.maxRetries,template.template.timeout,template.template.serviceAccount,template.template.containers[0].image,template.template.containers[0].command,template.template.containers[0].args,template.template.containers[0].env[].name,template.template.containers[0].env[].valueSource.secretKeyRef.name,template.template.containers[0].env[].valueSource.secretKeyRef.version)"
gcloud scheduler jobs list --project=amuhon-staging --location=asia-northeast1 --format="table(name,state,schedule,timeZone)"
```

The Job must point at the staging project only, use an immutable image digest, command empty, argument `--run-queue-once`, one task, parallelism one, retry count zero, 20-minute timeout, 2 CPU, 4 GiB, the existing worker identity, and the 1 GiB temporary disk mounted at `/app/tmp/pdf-renderer-worker`. Required runtime inputs are `SUPABASE_URL`, `AMUHON_PDF_QUEUE_PROJECT_REF`, `AMUHON_PDF_QUEUE_ENABLED=true`, and `SUPABASE_SECRET_KEY` from a numeric Secret Manager version. The Docker image supplies production mode, pinned browser mode, port, and font path. `NEXT_PUBLIC_SUPABASE_URL` is not a substitute for the worker's `SUPABASE_URL`. Do not print environment variable values when inspecting this configuration.

If local `gcloud` cannot access its configuration directory, stop rather than copying credentials or keys elsewhere. On the operator's normal Windows profile, run `gcloud auth login` and set the project explicitly, then repeat the read-only preflight. This workspace could report SDK version 593.0.0, but its Cloud SDK credential database was inaccessible; no cloud state was verified.

## First-time IAM setup (operator action; not applied here)

Use separate identities:

| Identity | Scope and access | Must not receive |
|---|---|---|
| `amuhon-cloudbuild-deployer@amuhon-staging.iam.gserviceaccount.com` | `roles/logging.logWriter` at the staging project; `roles/artifactregistry.writer` on only `asia-northeast1/amuhon-pdf-renderer`; custom job-updater role from `infra/iam/amuhon-staging-render-job-updater.yaml` bound to only `amuhon-pdf-renderer`; the read-only operation-reader role from `infra/iam/amuhon-staging-run-operation-reader.yaml` at project scope; `roles/iam.serviceAccountUser` on only the PDF worker service account if required for Job updates | Supabase secret access, Storage access, Stripe credentials, job execution, project Editor/Owner |
| `amuhon-pdf-worker@amuhon-staging.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` on only the staging Supabase secret | Artifact Registry writer, broad project roles, Stripe secret |
| `amuhon-pdf-scheduler@amuhon-staging.iam.gserviceaccount.com` | `roles/run.invoker` on only `amuhon-pdf-renderer` | Supabase, Storage, Artifact Registry, job configuration update |
| `amuhon-order-notification-worker@amuhon-staging.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` on only the staging Supabase and Resend secrets | Storage, Stripe, Artifact Registry writer, broad project roles |
| `amuhon-order-notification-scheduler@amuhon-staging.iam.gserviceaccount.com` | `roles/run.invoker` on only `amuhon-order-notification-worker` | Supabase, Storage, Artifact Registry, job configuration update |

The custom job role intentionally contains only `run.jobs.get` and `run.jobs.update`; bind it on each of the two named Jobs only. It has no create, delete, execute, or IAM policy permissions. The operation-reader role is read-only. Cloud Build's service agent must be able to impersonate the selected build service account as documented by Google; first inspect its existing service-agent grant and only repair the specific missing impersonation permission if Cloud Build reports it. Do not grant broad roles to a default Cloud Build account as a workaround. The trigger creator needs `roles/iam.serviceAccountUser` on the build identity. If a Cloud Storage source archive is used and logs specifically report a source object read denial, grant `roles/storage.objectViewer` on that exact source bucket to the build account; do not grant project-wide Storage access.

Example operator commands (review project and resource names first; do not run in this task):

```powershell
$Project = 'amuhon-staging'
$Region = 'asia-northeast1'
$BuildSa = 'amuhon-cloudbuild-deployer@amuhon-staging.iam.gserviceaccount.com'
$WorkerSa = 'amuhon-pdf-worker@amuhon-staging.iam.gserviceaccount.com'
$NotificationWorkerSa = 'amuhon-order-notification-worker@amuhon-staging.iam.gserviceaccount.com'
gcloud iam service-accounts create amuhon-cloudbuild-deployer --project=$Project --display-name="Amuhon staging image builder"
gcloud iam service-accounts create amuhon-pdf-scheduler --project=$Project --display-name="Amuhon staging PDF queue scheduler"
gcloud iam service-accounts create amuhon-order-notification-worker --project=$Project --display-name="Amuhon staging notification worker"
gcloud iam service-accounts create amuhon-order-notification-scheduler --project=$Project --display-name="Amuhon staging notification scheduler"
gcloud iam roles create amuhonStagingPdfJobUpdater --project=$Project --file=infra/iam/amuhon-staging-render-job-updater.yaml
gcloud iam roles create amuhonStagingRunOperationReader --project=$Project --file=infra/iam/amuhon-staging-run-operation-reader.yaml
gcloud artifacts repositories add-iam-policy-binding amuhon-pdf-renderer --project=$Project --location=$Region --member="serviceAccount:$BuildSa" --role=roles/artifactregistry.writer
gcloud run jobs add-iam-policy-binding amuhon-pdf-renderer --project=$Project --region=$Region --member="serviceAccount:$BuildSa" --role="projects/$Project/roles/amuhonStagingPdfJobUpdater"
gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$BuildSa" --role="projects/$Project/roles/amuhonStagingRunOperationReader"
gcloud iam service-accounts add-iam-policy-binding $WorkerSa --project=$Project --member="serviceAccount:$BuildSa" --role=roles/iam.serviceAccountUser
gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$BuildSa" --role=roles/logging.logWriter
```

After the notification Job exists, bind the existing update role to that Job and grant its Scheduler identity invoke-only access. Bind `roles/secretmanager.secretAccessor` on the Supabase and Resend secrets individually to `$NotificationWorkerSa`; do not grant it project-level Secret Manager access. These are operator setup instructions, not executed here.

```powershell
gcloud run jobs add-iam-policy-binding amuhon-order-notification-worker --project=$Project --region=$Region --member="serviceAccount:$BuildSa" --role="projects/$Project/roles/amuhonStagingPdfJobUpdater"
gcloud run jobs add-iam-policy-binding amuhon-order-notification-worker --project=$Project --region=$Region --member="serviceAccount:amuhon-order-notification-scheduler@amuhon-staging.iam.gserviceaccount.com" --role=roles/run.invoker
```

These commands create role definitions or change IAM and are intentionally documented only. If the project already has equivalent narrowly scoped bindings, reuse them rather than adding duplicates. Confirm the project number, Cloud Build service agent, existing service accounts and repository location in Console before applying any command.

Cloud Build, Artifact Registry, Cloud Run, Secret Manager, and Cloud Scheduler APIs must be enabled for the selected features. The first four are implied by the reported existing resources/build attempt, but their current state was not checked here. Check the Cloud Scheduler API and Billing before enabling it; creating a Scheduler job, not merely writing this file, is the step that starts recurring invocations and may incur charges.

## One-time Cloud Build trigger setup (operator action)

In Cloud Build > Triggers, confirm the GitHub repository connection for `madhouse202-ai/amuhon`, then create a **push-to-branch** trigger (not a pull-request trigger):

- Branch regex: `^codex/pdf-preview-fix-20261118$` (change only after deciding the long-lived protected staging branch).
- Configuration file: `cloudbuild.staging.yaml`.
- Trigger service account: the dedicated `amuhon-cloudbuild-deployer` identity, selected in the trigger UI.
- Substitution: `_DEPLOY_STAGING=true`.
- Source region: match the connected repository's region.
- Ensure the branch is protected/reviewed before enabling this trigger. Do not enable automatic deployment from an unprotected development branch.

The default build configuration does not publish or deploy. The trigger's explicit substitution is the deployment gate. After enabling, a reviewed push automatically runs tests, the Docker production build, offline synthetic render, image upload, digest resolution and update of the existing staging Job. Inspect the build record for commit SHA and success; confirm the Job's `source-commit` label and image digest. The Job is not automatically executed by a deployment.

If an existing trigger already matches this branch, inspect its config and service account before pushing this file. This environment could not list triggers because `gcloud` could not open its local credential database.

## Current paid queue and first controlled render

The 2026-11-21 order is reported as `paid`, rights/file checks passed, and its queue state is `queued`. Two older test orders are also reported as queued. No order was looked up or changed in this task.

**Important selection limit:** `--run-queue-once` claims the oldest eligible queue item. It cannot target the 2026-11-21 order. A first Job execution may process one of the older queued orders. Before the first render or scheduler activation, inspect all three orders using the authorized admin page and decide whether rendering each older test order is acceptable. The claim RPC skips active manual rights stops and terminally marks permanently ineligible snapshots; otherwise, older eligible orders can be rendered before the target. Do not run the Job until this queue ordering is understood. No one-off SQL insertion, deletion, status update or direct claim RPC is needed or permitted for routine operation.

For the first E2E, deploy the successful digest, inspect the queue in the admin page, and obtain operator approval for one Cloud Run execution. Verify that the selected order is intended. Then check that the admin detail reaches `succeeded`, both private assets are available only via the existing authorized admin download route, page count and checksums match, and Cloud Run logs contain `PDF_QUEUE_JOB_SUCCEEDED` / `APP_SERVER_STOPPED`. If execution fails, do not immediately repeat it; inspect the state and lease expiry first. Cloud Run retries remain 0; database attempts/leases own retries.

The worker processes at most one order per execution. It is not a backfill job, and paid orders with no queue row are not automatically enqueued. The 2026-11-21 order already has a reported queued row, so it needs no SQL action.

## Scheduler after the first successful E2E

Only after the first intended paid order reaches `succeeded`, create one Scheduler job with a 30-minute cadence. This yields a single claim per run, normally avoids overlapping 20-minute executions, and gives a later run time to reclaim a 30-minute lease after an interrupted task. Database row locks and lease checks remain the concurrency protection even if Scheduler delivers twice. Use one task, parallelism one, Cloud Run max retries 0, task timeout 20m. Scheduler delivery retries 0 initially; the next scheduled poll handles transient queue retries. The Scheduler does not submit orders or know any order IDs.

The Cloud Run Jobs API is a Google API; configure OAuth service account authentication, not an OIDC audience. Use the target `POST https://run.googleapis.com/v2/projects/amuhon-staging/locations/asia-northeast1/jobs/amuhon-pdf-renderer:run` with the scheduler service account. Grant `roles/run.invoker` on that Job only. Example (run only after human approval and checking that no Scheduler with this purpose already exists):

```powershell
$Project = 'amuhon-staging'
$Region = 'asia-northeast1'
$Job = 'amuhon-pdf-renderer'
$SchedulerSa = 'amuhon-pdf-scheduler@amuhon-staging.iam.gserviceaccount.com'
$Target = "https://run.googleapis.com/v2/projects/$Project/locations/$Region/jobs/${Job}:run"
gcloud run jobs add-iam-policy-binding $Job --project=$Project --region=$Region --member="serviceAccount:$SchedulerSa" --role=roles/run.invoker
gcloud scheduler jobs create http amuhon-pdf-renderer-poll --project=$Project --location=$Region --schedule="*/30 * * * *" --time-zone="Asia/Tokyo" --uri=$Target --http-method=POST --oauth-service-account-email=$SchedulerSa --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" --attempt-deadline=60s --max-retry-attempts=0
```

Cloud Scheduler's service agent is managed by Google. Verify its service-agent role after enabling the API; do not replace it with a user account. After creation, run only a read-only list/describe to confirm schedule, identity and target. Avoid the Scheduler “Run now” button until the queue order has been reviewed.

## Monitoring, failure handling and rollback

The admin order detail is the source of current per-order state. Create a Cloud Logging alert (no payload or resource labels containing order data) for fixed worker codes:

```text
resource.type="cloud_run_job"
resource.labels.job_name="amuhon-pdf-renderer"
textPayload=~"PDF_QUEUE_(TERMINAL_FAILURE|FAILURE_RECORDING_PENDING|FINALIZATION_UNKNOWN|CLAIM_FAILED|CLAIM_CONTRACT_MISMATCH|INTERNAL_FAILURE)|APP_SERVER_STOP_UNCONFIRMED"
```

Notify only operators; include timestamp, Job and fixed code. Also alert on repeated failed Cloud Run executions and a growing queued-job count. The latter should be a monitoring metric from the existing admin/status source or a reviewed database metric; do not expose order/customer payloads in alert messages. Budget alerts notify but do not cap spending. Monitor build failures, image digest/source commit, Cloud Run execution duration, retry count, storage orphan growth and monthly billing.

For deployment failure before image push, staging is unchanged. If image push succeeds but Job update fails, leave the prior Job revision in place; do not delete the pushed image. Inspect the fixed build step and permissions, then rerun only after correction. For a bad deployed renderer, stop/disable the Scheduler first, then restore the previously recorded immutable digest with an approved Job image update (or revert the code commit and let the same pipeline build the rollback). Never roll back by pointing at a mutable tag. Do not clear queue rows, modify leases, delete Storage objects or alter paid orders as a recovery shortcut.

## Cost estimate

At current reported sizing (2 vCPU, 4 GiB, 1 GiB ephemeral disk), Cloud Run Jobs have a one-minute minimum billable duration per started task. At the currently published Tokyo Tier 1 on-demand rates, the gross compute floor is about **US$0.00264 per idle invocation** (2×60 vCPU-seconds and 4×60 GiB-seconds). A 30-minute schedule makes about 1,440 invocations/month: about **US$3.80/month gross compute**, plus roughly **US$0.003/month** for 1 GiB ephemeral disk at 1 minute per run. A 10-minute schedule is roughly **US$11.40/month gross compute** plus disk. Actual rendering takes longer and costs proportionally more; Artifact Registry storage, Cloud Build, network egress, logs, Scheduler and Secret Manager are separate. Cloud Run Jobs CPU/RAM free tier is aggregated across the billing account, so 30-minute idle invocations may fall within unused monthly CPU/RAM free tier; do not assume a zero bill. Cloud Scheduler charges per configured job, not per execution; the first three jobs per billing account are currently free, then US$0.10/job/31 days. Recheck the price calculator and billing account before enabling the schedule. A 500-yen budget alert is not a spend cap.

## Production boundary

This pipeline is staging-only and hardcodes the staging project, repository, region, branch and Job. It must not be repurposed for production. Production requires a separate project, repository, runtime/build/scheduler identities, Secret Manager secret, protected release process and explicit human approval after staging E2E; none are created here. This automation never invokes Stripe, changes a payment, accesses an order directly, or contacts the printer.

## Official references

- [Cloud Build user-managed service accounts](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts) — explicit build identity, Cloud Logging, trigger identity behavior.
- [Cloud Build trigger security](https://docs.cloud.google.com/build/docs/automating-builds/create-manage-triggers) — push triggers and repository write access implications.
- [Artifact Registry with Cloud Build](https://docs.cloud.google.com/artifact-registry/docs/configure-cloud-build) — repository-scoped Writer role.
- [Cloud Run Jobs scheduling](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule) — Scheduler target and OAuth.
- [Cloud Run task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout) — max timeout applies per task attempt.
- [Cloud Run Job IAM permissions](https://docs.cloud.google.com/run/docs/reference/iam/permissions) — separate `run.jobs.update` and `run.jobs.run` permissions.
- [Cloud Run Job image update](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/update) and [Artifact Registry image digest lookup](https://docs.cloud.google.com/sdk/gcloud/reference/artifacts/docker/images/describe).
- [Cloud Run pricing](https://cloud.google.com/run/pricing) and [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing) — current free tiers and minimum Job billing.
