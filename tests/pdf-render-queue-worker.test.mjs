import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPdfRenderQueueWorker } from "../lib/pdf-render-queue-worker.ts";
import { createSupabasePdfRenderQueueAdapter, parsePdfRenderQueueConfig } from "../lib/pdf-render-queue-supabase.ts";

const orderId = "54f81d59-76a8-47a0-9f57-9d9a9c3d22b8";
const leaseId = "e27205c2-ff9a-4b45-a2e7-29c462af70e4";
const bookSnapshot = {
  title: "試験本", editor: "編者", coverStyle: "classic", coverColor: "blue",
  works: [{
    id: "000015", title: "作品一", author: "作者一",
    cardUrl: "https://www.aozora.gr.jp/cards/000000/card15.html",
    textUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.txt",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000000/files/15_1.html",
  }],
};
const claimed = {
  orderId, leaseId, leaseExpiresAt: "2030-01-01T00:15:00.000Z", attemptCount: 1,
  expectedBodyPdfPageCount: 88, bookSnapshot,
};
const body = Buffer.from("validated-pdf-placeholder");
const cover = Buffer.from("validated-png-placeholder");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = {
  bodyPdfBytes: body, coverPngBytes: cover, bodyPdfPageCount: 88,
  bodyPdfSha256: sha(body), coverPngSha256: sha(cover),
};
const workText = [{ id: "000015", title: "作品一", author: "作者一", text: "本文｜漢字《かんじ》。" }];
const envForAdapter = () => ({
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  AMUHON_PDF_QUEUE_PROJECT_REF: "abcdefghijklmnopqrst",
});
const makeDeps = (overrides = {}) => {
  const calls = { uploads: [], failures: [], commits: [], renders: [] };
  const deps = {
    rpc: {
      claim: async () => claimed,
      fail: async (...args) => { calls.failures.push(args); return true; },
      complete: async (input) => { calls.commits.push(input); return true; },
    },
    storage: { putIfAbsent: async (input) => { calls.uploads.push(input); } },
    loadWorkTexts: async () => workText,
    render: async (input) => { calls.renders.push(input); return assets; },
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, calls };
};

test("paid render queue uploads attempt-specific private assets and atomically commits exact page count", async () => {
  const { deps, calls } = makeDeps();
  const result = await createPdfRenderQueueWorker(deps).runOnce();
  assert.deepEqual(result, { status: "succeeded" });
  assert.equal(calls.renders[0].expectedPageCount, 88);
  assert.deepEqual(calls.uploads.map(({ key, contentType }) => [key, contentType]), [
    [`${orderId}/${leaseId}/body.pdf`, "application/pdf"],
    [`${orderId}/${leaseId}/cover.png`, "image/png"],
  ]);
  assert.equal(calls.commits[0].bodyPdfPageCount, 88);
  assert.equal(calls.commits[0].bodyPdfSha256, sha(body));
  assert.equal(calls.failures.length, 0);
});

test("page-count mismatch fails the lease before either private object is uploaded", async () => {
  const { deps, calls } = makeDeps({ render: async () => ({ ...assets, bodyPdfPageCount: 96 }) });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "terminal_failure", errorCode: "page_count_mismatch",
  });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.failures[0][2], "page_count_mismatch");
});

test("bad source snapshot is refused and never rendered or uploaded", async () => {
  const bad = structuredClone(claimed);
  bad.bookSnapshot.works[0].xhtmlUrl = "https://example.com/text.html";
  const { deps, calls } = makeDeps({ rpc: { claim: async () => bad, fail: async (...args) => { calls.failures.push(args); return true; }, complete: async () => true } });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "terminal_failure", errorCode: "invalid_snapshot",
  });
  assert.equal(calls.renders.length, 0);
  assert.equal(calls.uploads.length, 0);
});

test("expired lease does not write, render, or report a false success", async () => {
  const { deps, calls } = makeDeps({ now: () => Date.parse("2030-01-01T00:16:00.000Z") });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "lease_expired" });
  assert.equal(calls.renders.length, 0);
  assert.equal(calls.uploads.length, 0);
});

test("an expired lease after body upload leaves only an uncommitted private orphan", async () => {
  let now = Date.parse("2030-01-01T00:14:59.000Z");
  const { deps, calls } = makeDeps({
    now: () => now,
    storage: { putIfAbsent: async (input) => {
      calls.uploads.push(input);
      now = Date.parse("2030-01-01T00:15:01.000Z");
    } },
  });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "lease_expired" });
  assert.deepEqual(calls.uploads.map(({ key }) => key), [`${orderId}/${leaseId}/body.pdf`]);
  assert.equal(calls.failures.length, 0);
  assert.equal(calls.commits.length, 0);
});

test("storage failure is retried through the lease RPC and does not commit", async () => {
  const { deps, calls } = makeDeps({ storage: { putIfAbsent: async () => { throw new Error("private details"); } } });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "retry_queued", errorCode: "storage_unavailable",
  });
  assert.equal(calls.failures[0][2], "storage_unavailable");
  assert.equal(calls.commits.length, 0);
});

test("a failed cover upload leaves the existing order assets uncommitted", async () => {
  const calls = { uploads: [], failures: [], commits: [] };
  const { deps } = makeDeps({
    storage: { putIfAbsent: async (input) => {
      calls.uploads.push(input);
      if (input.key.endsWith("/cover.png")) throw new Error("private storage response");
    } },
    rpc: {
      claim: async () => claimed,
      fail: async (...args) => { calls.failures.push(args); return true; },
      complete: async (...args) => { calls.commits.push(args); return true; },
    },
  });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "retry_queued", errorCode: "storage_unavailable",
  });
  assert.deepEqual(calls.uploads.map(({ key }) => key), [
    `${orderId}/${leaseId}/body.pdf`,
    `${orderId}/${leaseId}/cover.png`,
  ]);
  assert.equal(calls.failures[0][2], "storage_unavailable");
  assert.equal(calls.commits.length, 0);
});

test("the fifth transient failure is terminal and is not reported as requeued", async () => {
  const fifthAttempt = { ...claimed, attemptCount: 5 };
  const { deps, calls } = makeDeps({
    rpc: {
      claim: async () => fifthAttempt,
      fail: async (...args) => { calls.failures.push(args); return true; },
      complete: async (...args) => { calls.commits.push(args); return true; },
    },
    render: async () => { throw new Error("worker_unavailable"); },
  });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "terminal_failure", errorCode: "worker_unavailable",
  });
  assert.equal(calls.failures[0][2], "worker_unavailable");
  assert.equal(calls.commits.length, 0);
});

test("the queue allows at most five render attempts before a transient failure becomes terminal", async () => {
  let attemptCount = 0;
  let state = "queued";
  const rpc = {
    claim: async () => {
      if (state !== "queued") return null;
      attemptCount += 1;
      state = "rendering";
      return { ...claimed, attemptCount };
    },
    fail: async () => {
      state = attemptCount < 5 ? "queued" : "failed";
      return true;
    },
    complete: async () => true,
  };
  const { deps } = makeDeps({ rpc, render: async () => { throw new Error("worker_unavailable"); } });
  const worker = createPdfRenderQueueWorker(deps);
  const outcomes = [];
  for (let index = 0; index < 5; index += 1) outcomes.push((await worker.runOnce()).status);
  assert.deepEqual(outcomes, ["retry_queued", "retry_queued", "retry_queued", "retry_queued", "terminal_failure"]);
  assert.equal(attemptCount, 5);
  assert.equal(state, "failed");
  assert.deepEqual(await worker.runOnce(), { status: "idle" });
  assert.equal(attemptCount, 5);
});

test("independent workers cannot claim the same queued order concurrently", async () => {
  let queueState = "queued";
  let renderCount = 0;
  let commitCount = 0;
  const sharedRpc = {
    claim: async () => {
      if (queueState !== "queued") return null;
      queueState = "rendering";
      return claimed;
    },
    fail: async () => true,
    complete: async () => { queueState = "succeeded"; commitCount += 1; return true; },
  };
  const first = makeDeps({ rpc: sharedRpc, render: async () => { renderCount += 1; return assets; } });
  const second = makeDeps({ rpc: sharedRpc, render: async () => { renderCount += 1; return assets; } });
  const results = await Promise.all([
    createPdfRenderQueueWorker(first.deps).runOnce(),
    createPdfRenderQueueWorker(second.deps).runOnce(),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["idle", "succeeded"]);
  assert.equal(renderCount, 1);
  assert.equal(commitCount, 1);
});

test("renderer timeout and unavailable Chromium are retryable safe codes", async () => {
  for (const code of ["processing_timeout", "worker_unavailable"]) {
    const { deps, calls } = makeDeps({ render: async () => { throw new Error(code); } });
    assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "retry_queued", errorCode: code });
    assert.equal(calls.failures[0][2], code);
    assert.equal(calls.uploads.length, 0);
  }
});

test("a mid-render failure never uploads either artifact and exposes no exception detail", async () => {
  const { deps, calls } = makeDeps({ render: async () => { throw new Error("secret-like renderer detail"); } });
  const outcome = await createPdfRenderQueueWorker(deps).runOnce();
  assert.deepEqual(outcome, { status: "terminal_failure", errorCode: "invalid_render" });
  assert.equal(JSON.stringify(outcome).includes("secret-like"), false);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.commits.length, 0);
  assert.equal(calls.failures[0][2], "invalid_render");
});

test("render output with an invalid digest is rejected before Storage", async () => {
  const { deps, calls } = makeDeps({ render: async () => ({ ...assets, bodyPdfSha256: "0".repeat(64) }) });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "terminal_failure", errorCode: "invalid_render",
  });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.commits.length, 0);
});

test("renderer-detected exact layout page-count mismatch is terminal", async () => {
  const { deps, calls } = makeDeps({ render: async () => { throw new Error("page_count_mismatch"); } });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), {
    status: "terminal_failure", errorCode: "page_count_mismatch",
  });
  assert.equal(calls.uploads.length, 0);
});

test("ambiguous completion response is not marked failed or retried under the same lease", async () => {
  const { deps, calls } = makeDeps({ rpc: {
    claim: async () => claimed,
    fail: async (...args) => { calls.failures.push(args); return true; },
    complete: async () => { throw new Error("private details"); },
  } });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "finalization_unknown" });
  assert.equal(calls.failures.length, 0);
  assert.equal(calls.uploads.length, 2);
});

test("a definite rejected completion remains lease-lost and does not rewrite order state", async () => {
  const { deps, calls } = makeDeps({ rpc: {
    claim: async () => claimed,
    fail: async (...args) => { calls.failures.push(args); return true; },
    complete: async (...args) => { calls.commits.push(args); return false; },
  } });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "lease_lost" });
  assert.equal(calls.uploads.length, 2);
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.failures.length, 0);
});

test("a later worker can reclaim an expired lease with a new lease-specific path", async () => {
  let state = "rendering";
  let activeLease = leaseId;
  let leaseExpiresAt = "2030-01-01T00:00:00.000Z";
  let attemptCount = 1;
  let committedLease = null;
  const reclaimedLease = "f032ae4b-3bb4-4777-83c4-497e9f86a3b1";
  const rpc = {
    claim: async () => {
      if (state === "rendering" && Date.parse(leaseExpiresAt) > Date.parse("2030-01-01T00:01:00.000Z")) return null;
      state = "rendering";
      activeLease = reclaimedLease;
      leaseExpiresAt = "2030-01-01T00:31:00.000Z";
      attemptCount += 1;
      return { ...claimed, leaseId: activeLease, leaseExpiresAt, attemptCount };
    },
    fail: async () => true,
    complete: async (input) => { state = "succeeded"; committedLease = input.leaseId; return true; },
  };
  const { deps, calls } = makeDeps({ rpc, now: () => Date.parse("2030-01-01T00:01:00.000Z") });
  assert.deepEqual(await createPdfRenderQueueWorker(deps).runOnce(), { status: "succeeded" });
  assert.equal(calls.uploads[0].key, `${orderId}/${reclaimedLease}/body.pdf`);
  assert.equal(calls.uploads[1].key, `${orderId}/${reclaimedLease}/cover.png`);
  assert.equal(committedLease, reclaimedLease);
});

test("one worker instance cannot start overlapping queue claims", async () => {
  let releaseClaim;
  let claims = 0;
  const { deps } = makeDeps({ rpc: {
    claim: async () => {
      claims += 1;
      await new Promise((resolve) => { releaseClaim = resolve; });
      return null;
    },
    fail: async () => true,
    complete: async () => true,
  } });
  const worker = createPdfRenderQueueWorker(deps);
  const first = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await worker.runOnce(), { status: "busy" });
  assert.equal(claims, 1);
  releaseClaim();
  assert.deepEqual(await first, { status: "idle" });
});

test("only the configured Supabase project host is accepted by the server adapter", () => {
  const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", AMUHON_PDF_QUEUE_PROJECT_REF: "abcdefghijklmnopqrst" };
  assert.ok(parsePdfRenderQueueConfig(env));
  assert.equal(parsePdfRenderQueueConfig({ ...env, SUPABASE_URL: "https://example.com" }), null);
  assert.equal(parsePdfRenderQueueConfig({ ...env, AMUHON_PDF_QUEUE_PROJECT_REF: "" }), null);
});

test("Supabase queue adapter uses apikey only, fixed RPCs and create-only private Storage", async () => {
  const env = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", AMUHON_PDF_QUEUE_PROJECT_REF: "abcdefghijklmnopqrst" };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("claim_amuhon")) return Response.json(claimed);
    if (String(url).includes("fail_amuhon")) return Response.json(true);
    if (String(url).includes("complete_amuhon")) return Response.json({ state: "succeeded" });
    return new Response(null, { status: 200 });
  };
  const adapter = createSupabasePdfRenderQueueAdapter(env, fetchImpl);
  assert.deepEqual(await adapter.claim(900), claimed);
  await adapter.putIfAbsent({ key: `${orderId}/${leaseId}/body.pdf`, bytes: body, contentType: "application/pdf" });
  assert.equal(await adapter.complete({
    orderId, leaseId, bodyObjectKey: `${orderId}/${leaseId}/body.pdf`, coverObjectKey: `${orderId}/${leaseId}/cover.png`,
    bodyPdfPageCount: 88, bodyPdfSha256: sha(body), coverPngSha256: sha(cover), bodyPdfSizeBytes: body.length, coverPngSizeBytes: cover.length,
  }), true);
  for (const request of requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("apikey"), "sb_secret_test");
    assert.equal(headers.has("authorization"), false);
    assert.equal(request.init.redirect, "error");
  }
  const storage = requests.find((request) => request.url.includes("/storage/v1/object/"));
  assert.ok(storage);
  assert.equal(new Headers(storage.init.headers).get("x-upsert"), "false");
  assert.match(storage.url, /amuhon-order-files/);
});

test("Storage conflict or server error is reduced to a fixed error without response-body disclosure", async () => {
  for (const status of [409, 500]) {
    const adapter = createSupabasePdfRenderQueueAdapter(envForAdapter(), async () =>
      new Response("sensitive storage error body", { status }));
    await assert.rejects(
      adapter.putIfAbsent({ key: `${orderId}/${leaseId}/body.pdf`, bytes: body, contentType: "application/pdf" }),
      (error) => error.message === "pdf_render_queue_adapter_error" && !error.message.includes("sensitive"),
    );
  }
});

test("new migration keeps paid transition, bounded lease, private access and exact asset/page commit", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261115000200_order_pdf_render_jobs.sql", import.meta.url), "utf8");
  assert.match(sql, /after update of status on public\.amuhon_orders[\s\S]*new\.status = 'paid'/i);
  assert.match(sql, /on conflict \(order_id\) do nothing/i);
  assert.match(sql, /target_order\.status <> 'paid'[\s\S]*target_order\.files_validated_at is null[\s\S]*target_order\.body_pdf_storage_path[\s\S]*target_order\.cover_png_storage_path/i);
  assert.match(sql, /files_validated_at is null or target_order\.body_pdf_page_count is distinct from p_body_pdf_page_count/i);
  assert.match(sql, /jobs\.state = 'rendering' and jobs\.lease_expires_at <= clock_timestamp\(\)/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /target_job\.attempt_count >= 5/i);
  assert.match(sql, /and target_job\.attempt_count < 5/i);
  assert.match(sql, /attempt_count = attempt_count \+ 1/i);
  assert.match(sql, /p_lease_seconds < 60 or p_lease_seconds > 1800/i);
  assert.match(sql, /attempt_count >= 5/i);
  assert.match(sql, /target_order\.body_pdf_page_count % 8 <> 0/i);
  assert.match(sql, /\(case when jsonb_typeof\(target_order\.book_snapshot -> 'works'\) = 'array'\s+then jsonb_array_length\(target_order\.book_snapshot -> 'works'\) not between 1 and 100\s+else true\s+end\) or/i);
  assert.match(sql, /p_order_id::text \|\| '\/' \|\| p_lease_id::text \|\| '\/body\.pdf'/i);
  assert.match(sql, /target_order\.body_pdf_page_count is distinct from p_body_pdf_page_count/i);
  assert.match(sql, /files_validated_at = v_completed_at/i);
  assert.doesNotMatch(sql, /set\s+status\s*=\s*'ready_for_payment'/i);
  assert.doesNotMatch(sql, /insert into public\.amuhon_order_pdf_render_jobs\s+select/i);
  assert.match(sql, /alter table public\.amuhon_order_pdf_render_jobs enable row level security/i);
  assert.match(sql, /revoke all on public\.amuhon_order_pdf_render_jobs from public, anon, authenticated, service_role/i);
  assert.equal((sql.match(/security definer/gi) ?? []).length, 5);
  assert.equal((sql.match(/set search_path = pg_catalog, pg_temp/gi) ?? []).length, 5);
  assert.equal((sql.match(/grant execute on function public\./gi) ?? []).length, 4);
});

test("staging queue verification SQL is read-only and reports only safe aggregate/catalog facts", async () => {
  const sql = await readFile(new URL("../supabase/verification/20261115000200_order_pdf_render_jobs_readonly.sql", import.meta.url), "utf8");
  assert.match(sql, /public\.claim_amuhon_order_pdf_render_job\(integer\)/i);
  assert.match(sql, /security_definer/i);
  assert.match(sql, /search_path_fixed/i);
  assert.match(sql, /has_table_privilege/i);
  assert.match(sql, /queue_table_no_public_select/i);
  assert.match(sql, /one_job_per_order_primary_key/i);
  assert.match(sql, /order_delete_restricted/i);
  assert.match(sql, /all_job_checks_validated/i);
  assert.match(sql, /storage\.buckets/i);
  assert.match(sql, /storage\.objects/i);
  assert.match(sql, /amuhon_order_files_deny_public_access/i);
  assert.match(sql, /amuhon-order-files/i);
  assert.match(sql, /count\(\*\)/i);
  assert.doesNotMatch(sql, /^\s*(?:insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|notify|call|do|begin|commit)\b/im);
  assert.doesNotMatch(sql, /select\s+(?:\*|[^;]*\b(?:email|phone|shipping_address|checkout_token|storage_path|object_key)\b)/i);
});
