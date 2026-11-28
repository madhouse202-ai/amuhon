import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20261128000200_pdf_render_rights_finalize_recheck.sql", import.meta.url);

async function readCompletionMigration() {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.complete_amuhon_order_pdf_render_job(");
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return { sql, fn: sql.slice(start, end + 4) };
}

test("completion migration preserves RPC signature, definer boundary, fixed path, and service-role-only grant", async () => {
  const { sql, fn } = await readCompletionMigration();
  assert.match(fn, /complete_amuhon_order_pdf_render_job\(\s*p_order_id uuid,\s*p_lease_id uuid,\s*p_body_object_key text,\s*p_cover_object_key text,\s*p_body_pdf_page_count integer,\s*p_body_pdf_sha256 text,\s*p_cover_png_sha256 text,\s*p_body_pdf_size_bytes integer,\s*p_cover_png_size_bytes integer\s*\)/i);
  assert.match(fn, /security definer\s+set search_path = pg_catalog, pg_temp/i);
  assert.match(fn, /p_body_object_key is distinct from \(p_order_id::text \|\| '\/' \|\| p_lease_id::text \|\| '\/body\.pdf'\)/i);
  assert.match(fn, /p_cover_object_key is distinct from \(p_order_id::text \|\| '\/' \|\| p_lease_id::text \|\| '\/cover\.png'\)/i);
  assert.match(sql, /revoke all on function public\.complete_amuhon_order_pdf_render_job\([^;]+ from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.complete_amuhon_order_pdf_render_job\([^;]+ to service_role/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
  assert.doesNotMatch(fn, /delete\s+from\s+public\.amuhon_orders/i);
});

test("only one active version of each common rights policy can be current", async () => {
  const { sql } = await readCompletionMigration();
  assert.match(sql, /create unique index if not exists amuhon_aozora_rights_one_active_policy_version\s+on public\.amuhon_aozora_rights_policy_registry\s*\(policy_id\)\s*where policy_status = 'active'/i);
});

test("completion serializes policy, scope, legacy rights, and manual-stop changes before checking current order rights", async () => {
  const { fn } = await readCompletionMigration();
  const relationLocks = [
    "amuhon_aozora_rights_policy_registry",
    "amuhon_aozora_rights_scope_batches",
    "amuhon_aozora_rights_scope_members",
    "amuhon_work_commercial_rights",
    "amuhon_work_rights_holders",
  ];
  for (const relation of relationLocks) assert.match(fn, new RegExp(`lock table public\\.${relation} in share mode`, "i"));
  assert.match(fn, /order by item\.value ->> 'id'[\s\S]*pg_catalog\.pg_advisory_xact_lock\([\s\S]*hashtextextended\(target_work ->> 'id', 0\)/i);
  assert.match(fn, /public\._amuhon_book_works_manual_stop_active_v1\(target_order\.book_snapshot -> 'works'\)/i);
  assert.match(fn, /public\._amuhon_book_works_rights_approved_v1\(target_order\.book_snapshot -> 'works', true\)/i);
  assert.ok(fn.indexOf("_amuhon_book_works_manual_stop_active_v1") < fn.indexOf("_amuhon_book_works_rights_approved_v1"));
  assert.ok(fn.indexOf("_amuhon_book_works_rights_approved_v1") < fn.indexOf("update public.amuhon_orders set"));
});

test("manual stop is requeued without consuming an attempt while suspended or changed rights fail closed", async () => {
  const { fn } = await readCompletionMigration();
  const stopBranch = fn.slice(fn.indexOf("if public._amuhon_book_works_manual_stop_active_v1"), fn.indexOf("if not public._amuhon_book_works_rights_approved_v1"));
  const ineligibleBranch = fn.slice(fn.indexOf("if not public._amuhon_book_works_rights_approved_v1"), fn.indexOf("if target_order.files_validated_at is null"));
  assert.match(stopBranch, /state = 'queued'[\s\S]*attempt_count = greatest\(attempt_count - 1, 0\)[\s\S]*return jsonb_build_object\('state', 'rights_stopped'\)/i);
  assert.match(ineligibleBranch, /state = 'failed'[\s\S]*error_code = 'rights_ineligible'[\s\S]*return jsonb_build_object\('state', 'rights_ineligible'\)/i);
  assert.doesNotMatch(`${stopBranch}\n${ineligibleBranch}`, /update public\.amuhon_orders/i);
});

test("normal completion keeps paid, lease, page-count, hash, and both-object atomic linkage checks", async () => {
  const { fn } = await readCompletionMigration();
  assert.match(fn, /target_order\.status <> 'paid'[\s\S]*target_job\.state <> 'rendering'[\s\S]*target_job\.lease_id is distinct from p_lease_id/i);
  assert.match(fn, /target_order\.body_pdf_page_count is distinct from p_body_pdf_page_count/i);
  assert.match(fn, /update public\.amuhon_orders set[\s\S]*body_pdf_storage_path = p_body_object_key[\s\S]*cover_png_storage_path = p_cover_object_key/i);
  assert.match(fn, /update public\.amuhon_order_pdf_render_jobs set[\s\S]*state = 'succeeded'/i);
  assert.match(fn, /return jsonb_build_object\('state', 'succeeded'\)/i);
});
