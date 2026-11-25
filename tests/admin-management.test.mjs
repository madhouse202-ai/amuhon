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
  assert.equal(canDownloadAdminOrderAssets({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted", renderState: "queued", rightsApproved: true }), false);
  assert.equal(canDownloadAdminOrderAssets({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted", renderState: "succeeded", rightsApproved: false }), false);
  assert.equal(canDownloadAdminOrderAssets({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted", renderState: "succeeded", rightsApproved: true }), true);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: false, fulfillmentStatus: "not_submitted" }), false);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: true, fulfillmentStatus: "submitted" }), false);
  assert.equal(canMarkOrderSubmitted({ status: "paid", assetsVerified: true, fulfillmentStatus: "not_submitted", renderState: "succeeded", rightsApproved: true }), true);
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
  const orderDetail = await read("app/api/admin/orders/[id]/route.ts");
  assert.match(orderDetail, /get_amuhon_admin_order_pdf_render_status/);
  assert.match(orderDetail, /get_amuhon_admin_order_paid_notification_status_v1/);
  assert.match(orderDetail, /get_amuhon_admin_order_customer_notification_status_v1/);
  assert.match(orderDetail, /customerNotifications/);
  assert.match(orderDetail, /let paidNotification: Record<string, unknown> = \{ state: "unavailable" \}/);
  assert.match(orderDetail, /let pdfRenderJob: Record<string, unknown> = \{ state: "unavailable" \}/);
  assert.match(orderDetail, /await requireAdmin\(\)[\s\S]*?createAdminServiceClient\(\)[\s\S]*?get_amuhon_admin_order_pdf_render_status/);
  const detailClient = await read("app/admin/orders/[id]/order-detail-client.tsx");
  assert.match(detailClient, /決済後の製本データ生成/);
  assert.match(detailClient, /state === "queued" \? "生成待ち"/);
  assert.match(detailClient, /state === "rendering" \? "生成中"/);
  assert.match(detailClient, /生成完了/);
  assert.match(detailClient, /state === "failed" \? `生成に失敗しました/);
  assert.match(detailClient, /state === "not_queued" \? "生成ジョブがありません/);
  assert.match(detailClient, /<h2 className="font-semibold">決済通知メール<\/h2>/);
  assert.match(detailClient, /state === "needs_review" \? `要確認/);
  assert.match(detailClient, /通知機能が無効だった期間の注文のため、送信対象外です/);
  assert.match(detailClient, /お客様へのメール通知/);
  assert.match(detailClient, /注文確定メール/);
  assert.match(detailClient, /発送通知メール/);
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
  assert.doesNotMatch(browserClient, /SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY)|AMUHON_ADMIN_USER_ID/);
  assert.doesNotMatch(login, /SUPABASE_SERVICE_ROLE_KEY|AMUHON_ADMIN_USER_ID/);
});

test("server Supabase calls share new-key header handling without changing admin authorization", async () => {
  const credential = await read("lib/supabase-service-credential.ts");
  const adminData = await read("lib/admin-data.ts");
  const serviceRoutes = [
    "app/api/orders/route.ts",
    "app/api/orders/[id]/uploads/route.ts",
    "app/api/orders/[id]/files/route.ts",
    "app/api/orders/[id]/validation/route.ts",
    "app/api/internal/cleanup-order-uploads/route.ts",
    "app/api/internal/cleanup-order-temp-uploads/route.ts",
  ];
  assert.match(credential, /SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(credential, /SUPABASE_SERVICE_ROLE_KEY|legacy_service_role/);
  assert.match(credential, /headers\.delete\("authorization"\)/);
  assert.match(adminData, /createSupabaseServiceFetch\(serviceCredential\)/);
  assert.match(adminData, /createSupabaseServiceHeaders\(serviceCredential\)/);
  for (const path of ["lib/supabase/client.ts", "lib/supabase/server.ts", "lib/supabase/proxy.ts", "app/order/page.tsx", "app/admin/login/login-form.tsx"]) {
    const source = await read(path);
    assert.doesNotMatch(source, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|supabase-service-credential/,
      `${path} must not reference server-only service credentials`);
  }
  for (const path of serviceRoutes) {
    const source = await read(path);
    assert.match(source, /getSupabaseServiceCredential\(\)/, path);
    assert.match(source, /createSupabaseServiceHeaders\((?:serviceCredential|credential|config\.serviceCredential)/, path);
    assert.doesNotMatch(source, /Authorization:\s*`Bearer \$\{(?:serviceRoleKey|key|config\.serviceRoleKey)\}`/, path);
  }

  for (const path of [
    "app/api/admin/orders/route.ts",
    "app/api/admin/orders/[id]/route.ts",
    "app/api/admin/orders/[id]/files/[asset]/route.ts",
    "app/api/admin/orders/[id]/submission/route.ts",
  ]) {
    const source = await read(path);
    assert.ok(source.indexOf("await requireAdmin()") < source.indexOf("createAdminServiceClient()"), path);
  }
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

test("printer submission requires a vendor confirmation, readiness, rights review, and an audit entry", async () => {
  const [migration, submissionRoute, detailRoute, detailClient] = await Promise.all([
    read("supabase/migrations/20261118000200_order_printer_confirmation_audit.sql"),
    read("app/api/admin/orders/[id]/submission/route.ts"),
    read("app/api/admin/orders/[id]/route.ts"),
    read("app/admin/orders/[id]/order-detail-client.tsx"),
  ]);
  assert.match(migration, /mark_amuhon_order_printer_submitted_v2/);
  assert.match(migration, /p_vendor_order_confirmed is distinct from true/);
  assert.match(migration, /_amuhon_order_print_assets_ready_v1/);
  assert.match(migration, /p_next_status <> 'on_hold' and not public\._amuhon_order_print_assets_ready_v1\(p_order_id\)/);
  assert.match(migration, /_amuhon_book_works_rights_approved_v1/);
  assert.match(migration, /amuhon_order_fulfillment_events/);
  assert.match(migration, /get_amuhon_admin_order_fulfillment_audit_v1/);
  assert.match(migration, /LEGACY_SUBMISSION_RPC_DISABLED/);
  assert.match(submissionRoute, /mark_amuhon_order_printer_submitted_v2/);
  assert.match(submissionRoute, /await requireAdmin\(\)[\s\S]*?createAdminServiceClient\(\)/);
  assert.match(detailRoute, /get_amuhon_admin_order_production_readiness_v1/);
  assert.match(detailRoute, /get_amuhon_admin_order_fulfillment_audit_v1/);
  assert.match(detailClient, /製本直送\.com側で注文確定したことを確認しました/);
  assert.match(detailClient, /権利台帳のA判定がないため/);
  assert.match(detailClient, /nextStatus !== "on_hold"/);
});
