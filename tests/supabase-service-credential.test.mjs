import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createSupabaseServiceFetch,
  createSupabaseServiceHeaders,
  getSupabaseServiceCredential,
} from "../lib/supabase-service-credential.ts";

const SECRET_KEY = "sb_secret_mock-only-not-a-real-key";
const LEGACY_KEY = "legacy-mock-only-not-a-real-key";

test("new secret key is required and malformed or missing configuration fails closed", () => {
  assert.deepEqual(getSupabaseServiceCredential({
    SUPABASE_SECRET_KEY: SECRET_KEY,
  }), { apiKey: SECRET_KEY, source: "secret" });

  assert.equal(getSupabaseServiceCredential({
    SUPABASE_SECRET_KEY: "wrong-format",
    SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY,
  }), null);
  assert.equal(getSupabaseServiceCredential({}), null);
  assert.equal(getSupabaseServiceCredential({ SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }), null);
  assert.equal(getSupabaseServiceCredential({ SUPABASE_SECRET_KEY: ` ${SECRET_KEY}` }), null);
});

test("server credential helper contains no legacy runtime fallback", async () => {
  const source = await readFile(new URL("../lib/supabase-service-credential.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|legacy_service_role/);
});

test("new secret is sent only as apikey and any Bearer header is removed", () => {
  const secretHeaders = createSupabaseServiceHeaders(
    { apiKey: SECRET_KEY, source: "secret" },
    { Authorization: "Bearer stale-value", "Content-Type": "application/json" },
  );
  assert.equal(secretHeaders.get("apikey"), SECRET_KEY);
  assert.equal(secretHeaders.has("authorization"), false);
  assert.equal(secretHeaders.get("content-type"), "application/json");

});

test("service fetch removes the SDK's API-key Bearer fallback", async () => {
  const captured = [];
  const mockFetch = async (input, init) => {
    captured.push({ input, init });
    return new Response(null, { status: 204 });
  };

  const secretFetch = createSupabaseServiceFetch({ apiKey: SECRET_KEY, source: "secret" }, mockFetch);
  await secretFetch("https://project.example/rest/v1/rpc/fixed", {
    method: "POST",
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    body: "{}",
  });
  assert.equal(captured[0].init.headers.get("apikey"), SECRET_KEY);
  assert.equal(captured[0].init.headers.has("authorization"), false);
  assert.equal(captured[0].init.method, "POST");
  assert.equal(captured[0].init.body, "{}");

});
