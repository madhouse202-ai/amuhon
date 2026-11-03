import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { authorizeAdminSubject, canDownloadAdminOrderAssets, canMarkOrderSubmitted } from "../lib/admin-authorization.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const ADMIN_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";

test("admin allowlist fails closed when missing or malformed and compares only UUID subjects", () => {
  assert.deepEqual(authorizeAdminSubject(undefined, ADMIN_ID, true), { allowed: false, reason: "admin_id_unconfigured" });
  assert.deepEqual(authorizeAdminSubject("not-a-uuid", ADMIN_ID, true), { allowed: false, reason: "admin_id_unconfigured" });
  assert.deepEqual(authorizeAdminSubject(` ${ADMIN_ID}`, ADMIN_ID, true), { allowed: false, reason: "admin_id_unconfigured" });
  assert.deepEqual(authorizeAdminSubject(ADMIN_ID, null, false), { allowed: false, reason: "unauthenticated" });
  assert.deepEqual(authorizeAdminSubject(ADMIN_ID, "00000000-0000-4000-8000-000000000001", true), { allowed: false, reason: "forbidden" });
  assert.deepEqual(authorizeAdminSubject(ADMIN_ID, ADMIN_ID.toUpperCase(), true), { allowed: true, userId: ADMIN_ID });
});

test("download and submission policies require paid orders and verified assets", () => {
  assert.equal(canDownloadAdminOrderAssets({ status: "ready_for_payment", assetsVerified: true, fulfillmentStatus: "not_submitted" }), false);
  assert.equal(canDownloadAdminOrderAssets({ status: "paid", assetsVerified: false, fulfillmentStatus: "not_submitted" }), false);
  assert.equal(canDownloadAdminOrderAssets({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted" }), true);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: false, fulfillmentStatus: "not_submitted" }), false);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: true, fulfillmentStatus: "submitted" }), false);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted" }), true);
});

test("every admin data API verifies the server-side admin before service-role access", async () => {
  const routes = [
    "app/api/admin/orders/route.ts",
    "app/api/admin/orders/[id]/route.ts",
    "app/api/admin/orders/[id]/files/[asset]/route.ts",
    "app/api/admin/orders/[id]/submission/route.ts",
  ];
  for (const path of routes) {
    const source = await read(path);
    const auth = source.indexOf("await requireAdmin()");
    const service = source.indexOf("createAdminServiceClient()");
    assert.ok(auth >= 0, `${path} must require admin`);
    assert.ok(service < 0 || auth < service, `${path} must authorize before using service_role`);
    assert.match(source, /adminAuthFailureResponse\(auth\)/, path);
    assert.match(source, /Cache-Control/, path);
  }
});

test("Auth uses verified claims and never treats email or service_role as administrator identity", async () => {
  const auth = await read("lib/admin-auth.ts");
  const authorization = await read("lib/admin-authorization.ts");
  assert.match(auth, /auth\.getClaims\(\)/);
  assert.match(auth, /claims\.sub/);
  assert.match(auth, /claims\.role !== "authenticated"/);
  assert.match(auth, /process\.env\.AMUHON_ADMIN_USER_ID/);
  assert.doesNotMatch(auth, /service_role|SUPABASE_SERVICE_ROLE_KEY|email/);
  assert.doesNotMatch(authorization, /email|service_role/i);
});

test("login has no signup path and admin browser code contains no server-only secret", async () => {
  const login = await read("app/admin/login/login-form.tsx");
  const browserClient = await read("lib/supabase/client.ts");
  assert.match(login, /signInWithPassword/);
  assert.doesNotMatch(login, /signUp/);
  assert.doesNotMatch(browserClient, /SUPABASE_SERVICE_ROLE_KEY|AMUHON_ADMIN_USER_ID/);
  assert.doesNotMatch(login, /SUPABASE_SERVICE_ROLE_KEY|AMUHON_ADMIN_USER_ID/);
});

test("fulfillment migration keeps payment status separate and makes updates atomic and idempotent", async () => {
  const sql = await read("supabase/migrations/20261103000200_order_admin_fulfillment.sql");
  assert.match(sql, /printer_submission_status text not null default 'not_submitted'/i);
  assert.match(sql, /\(printer_submitted_at is null\) = \(printer_submitted_by is null\)[\s\S]*?printer_submission_status = 'submitted'[\s\S]*?printer_submitted_at is not null and printer_submitted_by is not null/i);
  assert.match(sql, /jsonb_build_object\(\s*'orders', coalesce\(jsonb_agg/i);
  assert.match(sql, /select \* into target from public\.amuhon_orders where id = p_order_id for update/i);
  assert.match(sql, /if target\.status <> 'paid' then raise exception 'ORDER_NOT_PAID'/i);
  assert.match(sql, /target\.files_validated_at is not null/i);
  assert.match(sql, /asset_paths_verified :=/i);
  assert.match(sql, /target\.body_pdf_storage_path ~ \('\^' \|\| target\.id::text \|\| '\/\[0-9a-f\]/i);
  assert.match(sql, /regexp_replace\(target\.body_pdf_storage_path, '\/body\[\.\]pdf\$'/i);
  assert.match(sql, /target\.printer_submission_status = 'submitted'[\s\S]*?already_submitted/i);
  assert.match(sql, /printer_submission_status = 'submitted',[\s\S]*?printer_submitted_at = now\(\),[\s\S]*?printer_submitted_by = p_admin_user_id/i);
  assert.equal((sql.match(/security definer/gi) ?? []).length, 4);
  assert.equal((sql.match(/set search_path = pg_catalog, pg_temp/gi) ?? []).length, 4);
  assert.equal((sql.match(/grant execute on function public\./gi) ?? []).length, 4);
  assert.doesNotMatch(sql, /grant\s+select\s+on\s+public\.amuhon_orders/i);
});

test("asset API streams only fixed private-object paths and never returns a signed/public URL", async () => {
  const source = await read("lib/admin-data.ts");
  const route = await read("app/api/admin/orders/[id]/files/[asset]/route.ts");
  assert.match(source, /get_amuhon_admin_order_asset/);
  assert.match(source, /ORDER_FILES_BUCKET = "amuhon-order-files"/);
  assert.match(source, /isExpectedOrderAssetPath\(orderId, info\.storagePath, fileName\)/);
  assert.match(source, /info\.storagePath\.split\("\/"\)/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /MAX_ADMIN_DOWNLOAD_BYTES = 40_000_000/);
  assert.match(source, /actualHash !== info\.sha256/);
  assert.match(route, /requireAdmin\(\)/);
  assert.match(route, /Content-Disposition/);
  assert.doesNotMatch(source, /createSignedUrl|getPublicUrl/);
});
