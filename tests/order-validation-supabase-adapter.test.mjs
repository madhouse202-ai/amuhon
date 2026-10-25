import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createSupabaseOrderValidationAdapters } from "../lib/order-validation-supabase-adapter.ts";
import {
  OrderAssetTooLargeError,
  ValidationClaimContractError,
  ValidationLeaseLostError,
} from "../lib/order-validation-worker.ts";

const orderId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const leaseId = "33333333-3333-4333-8333-333333333333";
const bodyKey = `${orderId}/${attemptId}/body.pdf`;
const coverKey = `${orderId}/${attemptId}/cover.png`;
const baseUrl = "https://test-project.supabase.co";

function setup() {
  const previous = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = baseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-only-service-role-key";
  return {
    restore() {
      if (previous.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previous.url;
      if (previous.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;
    },
  };
}

function claimPayload() {
  return {
    orderId,
    attemptId,
    leaseId,
    leaseExpiresAt: "2026-10-25T12:05:00.000Z",
    declaredPageCount: 24,
    attemptCount: 1,
    state: "validating",
    bodyObjectKey: bodyKey,
    coverObjectKey: coverKey,
  };
}

function rpcResponse(value, status = 200) {
  return new Response(value === undefined ? null : JSON.stringify(value), { status });
}

function streamResponse(chunks, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers });
}

test("claim uses exact RPC contract, validates keys, and never calls legacy complete", async (t) => {
  const env = setup();
  t.after(env.restore);
  const calls = [];
  const { rpc } = createSupabaseOrderValidationAdapters({
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return rpcResponse(claimPayload());
    },
  });
  const result = await rpc.claim({ leaseSeconds: 300 });
  assert.deepEqual(result, {
    orderId,
    attemptId,
    leaseId,
    leaseExpiresAt: "2026-10-25T12:05:00.000Z",
    declaredPageCount: 24,
    bodyObjectKey: bodyKey,
    coverObjectKey: coverKey,
  });
  assert.equal(calls[0].url, `${baseUrl}/rest/v1/rpc/claim_amuhon_order_validation_job`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_lease_seconds: 300 });
  assert.equal(calls[0].init.headers.get("apikey"), "mock-only-service-role-key");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer mock-only-service-role-key");
  assert.equal(calls.some((call) => call.url.includes("complete_amuhon_order_validation_job")), false);
});

test("claim requires an explicit valid declaredPageCount contract", async (t) => {
  const env = setup();
  t.after(env.restore);

  const nullDeclaration = createSupabaseOrderValidationAdapters({
    fetchImpl: async () => rpcResponse({ ...claimPayload(), declaredPageCount: null }),
  });
  assert.equal((await nullDeclaration.rpc.claim({ leaseSeconds: 300 }))?.declaredPageCount, null);

  const missingField = createSupabaseOrderValidationAdapters({
    fetchImpl: async () => {
      const payload = claimPayload();
      delete payload.declaredPageCount;
      return rpcResponse(payload);
    },
  });
  await assert.rejects(
    missingField.rpc.claim({ leaseSeconds: 300 }),
    ValidationClaimContractError,
  );

  for (const declaredPageCount of [0, -1, 1.5, "24"]) {
    const invalidField = createSupabaseOrderValidationAdapters({
      fetchImpl: async () => rpcResponse({ ...claimPayload(), declaredPageCount }),
    });
    await assert.rejects(
      invalidField.rpc.claim({ leaseSeconds: 300 }),
      ValidationClaimContractError,
    );
  }
});

test("null claim is idle and malformed claim is rejected", async (t) => {
  const env = setup();
  t.after(env.restore);
  const idle = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse(null) });
  assert.equal(await idle.rpc.claim({ leaseSeconds: 300 }), null);
  const malformed = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse({ ...claimPayload(), bodyObjectKey: "other/body.pdf" }) });
  await assert.rejects(malformed.rpc.claim({ leaseSeconds: 300 }));
});

test("fail RPC sends exact arguments and maps stale lease to false", async (t) => {
  const env = setup();
  t.after(env.restore);
  let request;
  const ok = createSupabaseOrderValidationAdapters({ fetchImpl: async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return rpcResponse(true);
  } });
  assert.equal(await ok.rpc.fail({ attemptId, leaseId, errorCode: "invalid_pdf" }), true);
  assert.deepEqual(request.body, { p_attempt_id: attemptId, p_lease_id: leaseId, p_error_code: "invalid_pdf" });

  const stale = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse({ message: "VALIDATION_LEASE_STALE" }, 400) });
  assert.equal(await stale.rpc.fail({ attemptId, leaseId, errorCode: "invalid_pdf" }), false);
});

test("commit uses atomic RPC and maps stale lease; read status handles unknown state", async (t) => {
  const env = setup();
  t.after(env.restore);
  const commit = {
    orderId,
    attemptId,
    leaseId,
    bodyObjectKey: bodyKey,
    coverObjectKey: coverKey,
    bodyPdfPageCount: 24,
    bodyPdfSha256: "a".repeat(64),
    coverPngSha256: "b".repeat(64),
    bodyPdfBytes: 123,
    coverPngBytes: 456,
  };
  let request;
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return rpcResponse({ state: "committed", orderId, attemptId });
  } });
  await adapters.rpc.commitValidatedAssets(commit);
  assert.equal(request.url, `${baseUrl}/rest/v1/rpc/commit_amuhon_order_validation_assets`);
  assert.deepEqual(request.body, {
    p_order_id: orderId,
    p_attempt_id: attemptId,
    p_lease_id: leaseId,
    p_body_pdf_page_count: 24,
    p_body_pdf_storage_path: bodyKey,
    p_cover_png_storage_path: coverKey,
    p_body_pdf_sha256: "a".repeat(64),
    p_cover_png_sha256: "b".repeat(64),
    p_body_pdf_size_bytes: 123,
    p_cover_png_size_bytes: 456,
  });

  const stale = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse({ message: "VALIDATION_LEASE_STALE" }, 400) });
  await assert.rejects(stale.rpc.commitValidatedAssets(commit), ValidationLeaseLostError);

  const unknown = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse({ state: "inconsistent", attemptId }) });
  assert.equal(await unknown.rpc.readAssetCommitState({ attemptId }), "unknown");
});

test("an uncertain commit response is resolved only through the read-only status RPC", async (t) => {
  const env = setup();
  t.after(env.restore);
  const requests = [];
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/commit_amuhon_order_validation_assets")) {
      throw new Error("mocked response timeout");
    }
    return rpcResponse({ state: "not_committed", attemptId, jobState: "validating" });
  } });
  await assert.rejects(adapters.rpc.commitValidatedAssets({
    orderId,
    attemptId,
    leaseId,
    bodyObjectKey: bodyKey,
    coverObjectKey: coverKey,
    bodyPdfPageCount: 24,
    bodyPdfSha256: "a".repeat(64),
    coverPngSha256: "b".repeat(64),
    bodyPdfBytes: 123,
    coverPngBytes: 456,
  }));
  assert.equal(await adapters.rpc.readAssetCommitState({ attemptId }), "not_committed");
  assert.deepEqual(requests, [
    `${baseUrl}/rest/v1/rpc/commit_amuhon_order_validation_assets`,
    `${baseUrl}/rest/v1/rpc/get_amuhon_order_validation_asset_commit_status`,
  ]);
});

test("readAssetCommitState maps only authoritative known states", async (t) => {
  const env = setup();
  t.after(env.restore);
  const states = ["committed", "not_committed", "unknown"];
  for (const state of states) {
    const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async () => rpcResponse({ state, attemptId }) });
    assert.equal(await adapters.rpc.readAssetCommitState({ attemptId }), state);
  }
});

test("temporary object download streams under the cap and rejects oversized Content-Length", async (t) => {
  const env = setup();
  t.after(env.restore);
  const payload = Buffer.from("bounded stream bytes");
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (url, init) => {
    assert.equal(String(url), `${baseUrl}/storage/v1/object/amuhon-order-temp-files/${bodyKey}`);
    assert.equal(init.method, "GET");
    return streamResponse([payload.subarray(0, 5), payload.subarray(5)], { "content-length": String(payload.byteLength) });
  } });
  const asset = await adapters.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: bodyKey });
  assert.equal(asset.sizeBytes, payload.byteLength);
  assert.deepEqual(Buffer.from(asset.bytes), payload);

  let canceled = false;
  const oversized = createSupabaseOrderValidationAdapters({ fetchImpl: async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { status: 200, headers: { "content-length": "40000001" } }) });
  await assert.rejects(
    oversized.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: bodyKey }),
    OrderAssetTooLargeError,
  );
  assert.equal(canceled, true);

  const streamedOverage = Buffer.alloc(40_000_001);
  const overLimitStream = createSupabaseOrderValidationAdapters({ fetchImpl: async () => streamResponse([streamedOverage]) });
  await assert.rejects(
    overLimitStream.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: bodyKey }),
    OrderAssetTooLargeError,
  );
});

test("404, network interruption, and malformed keys fail without cleanup or deletion requests", async (t) => {
  const env = setup();
  t.after(env.restore);
  const missing = createSupabaseOrderValidationAdapters({ fetchImpl: async () => new Response(null, { status: 404 }) });
  await assert.rejects(missing.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: bodyKey }));
  const interrupted = createSupabaseOrderValidationAdapters({ fetchImpl: async () => { throw new Error("network down"); } });
  await assert.rejects(interrupted.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: bodyKey }));
  await assert.rejects(interrupted.rpc.claim({ leaseSeconds: 300 }));
  await assert.rejects(missing.storage.downloadTemporaryObject({ bucket: "amuhon-order-temp-files", key: "../body.pdf" }));
});

test("final object creation is no-overwrite and accepts existing bytes only by SHA-256", async (t) => {
  const env = setup();
  t.after(env.restore);
  const bytes = Buffer.from("mock validated PDF bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "POST") {
      assert.equal(init.headers.get("x-upsert"), "false");
      assert.equal(init.headers.get("content-type"), "application/pdf");
      return new Response(null, { status: 409 });
    }
    return streamResponse([bytes]);
  } });
  await adapters.storage.saveFinalObjectIfAbsent({
    bucket: "amuhon-order-files", key: bodyKey, bytes, sha256: hash, contentType: "application/pdf",
  });
  assert.deepEqual(calls.map((call) => call.init.method), ["POST", "GET"]);
  assert.equal(calls[0].url, `${baseUrl}/storage/v1/object/amuhon-order-files/${bodyKey}`);
});

test("final object mismatch is rejected and never retried with overwrite", async (t) => {
  const env = setup();
  t.after(env.restore);
  const bytes = Buffer.from("new bytes");
  const existing = Buffer.from("different existing bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const methods = [];
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (_url, init) => {
    methods.push(init.method);
    return init.method === "POST"
      ? new Response(null, { status: 409 })
      : streamResponse([existing]);
  } });
  await assert.rejects(adapters.storage.saveFinalObjectIfAbsent({
    bucket: "amuhon-order-files", key: bodyKey, bytes, sha256: hash, contentType: "application/pdf",
  }));
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("ambiguous create response is resolved by reading and hashing the immutable object", async (t) => {
  const env = setup();
  t.after(env.restore);
  const bytes = Buffer.from("the server stored this before the connection dropped");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let count = 0;
  const adapters = createSupabaseOrderValidationAdapters({ fetchImpl: async (_url, init) => {
    count += 1;
    if (init.method === "POST") throw new Error("connection lost after write");
    return streamResponse([bytes]);
  } });
  await adapters.storage.saveFinalObjectIfAbsent({
    bucket: "amuhon-order-files", key: bodyKey, bytes, sha256: hash, contentType: "application/pdf",
  });
  assert.equal(count, 2);
});
