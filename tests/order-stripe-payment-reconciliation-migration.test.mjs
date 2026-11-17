import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20261117000100_order_stripe_payment_reconciliation.sql", import.meta.url), "utf8");
const queueSql = await readFile(new URL("../supabase/migrations/20261115000200_order_pdf_render_jobs.sql", import.meta.url), "utf8");

test("reconciliation migration adds only token-protected service RPCs with fixed SECURITY DEFINER search paths", () => {
  assert.equal((sql.match(/create or replace function public\./gi) ?? []).length, 2);
  assert.equal((sql.match(/grant execute on function public\./gi) ?? []).length, 2);
  assert.match(sql, /get_amuhon_order_payment_reconciliation_v1\(uuid, text\)[\s\S]*?to service_role/i);
  assert.match(sql, /reconcile_amuhon_stripe_checkout_paid_v1\(uuid, text, uuid, text, bigint, bigint, text, text, boolean\)[\s\S]*?to service_role/i);
  for (const functionBlock of sql.matchAll(/create or replace function public\.[\s\S]*?\n\$\$;/gi)) {
    assert.match(functionBlock[0], /security definer/i);
    assert.match(functionBlock[0], /set search_path = pg_catalog, pg_temp/i);
    assert.match(functionBlock[0], /p_upload_token_hash !~ '\^\[a-f0-9\]\{64\}\$'/i);
  }
  assert.match(sql, /revoke all on function public\.[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
  assert.match(sql, /^begin;/i);
  assert.match(sql, /commit;\s*$/i);
});

test("paid recovery validates stored session, attempt, verified assets, price, JPY, mode, and locks the order", () => {
  assert.match(sql, /from public\.amuhon_orders where id = p_order_id for update/i);
  assert.match(sql, /stripe_checkout_attempt_id is distinct from p_checkout_attempt_id/i);
  assert.match(sql, /stripe_checkout_session_id is distinct from p_session_id/i);
  assert.match(sql, /stripe_checkout_expires_at is distinct from session_expiry/i);
  assert.match(sql, /stripe_checkout_livemode is distinct from p_livemode/i);
  assert.match(sql, /p_currency is distinct from 'jpy'/i);
  assert.match(sql, /p_amount_total is distinct from expected_amount/i);
  assert.match(sql, /files_validated_at is null/i);
  assert.match(sql, /body_pdf_sha256 is null/i);
  assert.match(sql, /cover_png_sha256 is null/i);
  assert.match(sql, /target\.status is distinct from 'ready_for_payment'/i);
  assert.match(sql, /target\.status = 'paid'[\s\S]*?return jsonb_build_object\('state', 'already_paid'/i);
  assert.match(sql, /set status = 'paid', stripe_payment_id = p_payment_intent_id/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.amuhon_order_pdf_render_jobs/i);
});

test("the existing paid-transition trigger remains the single PDF queue path and is order-idempotent", () => {
  assert.match(queueSql, /if old\.status is distinct from new\.status and new\.status = 'paid' then[\s\S]*?on conflict \(order_id\) do nothing/i);
  assert.match(queueSql, /after update of status on public\.amuhon_orders/i);
  assert.match(sql, /updating status fires the existing paid-transition pdf queue trigger/i);
});
