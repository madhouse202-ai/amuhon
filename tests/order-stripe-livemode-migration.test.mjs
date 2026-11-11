import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20261111000100_order_stripe_livemode.sql", import.meta.url), "utf8");

test("migration binds existing test-only checkout rows to test mode and constrains both ID prefixes", () => {
  assert.match(sql, /add column if not exists stripe_checkout_livemode boolean/i);
  assert.match(sql, /set stripe_checkout_livemode = false[\s\S]*?stripe_checkout_attempt_id is not null[\s\S]*?status = 'paid'/i);
  assert.match(sql, /add column if not exists livemode boolean not null default false/i);
  assert.match(sql, /livemode = false and checkout_session_id ~ '\^cs_test_/i);
  assert.match(sql, /livemode = true and checkout_session_id ~ '\^cs_live_/i);
  assert.match(sql, /stripe_checkout_livemode is false and stripe_checkout_session_id ~ '\^cs_test_/i);
  assert.match(sql, /stripe_checkout_livemode is true and stripe_checkout_session_id ~ '\^cs_live_/i);
});

test("mode-aware checkout and webhook RPCs preserve row locking, price and verified-file checks", () => {
  for (const name of [
    "begin_amuhon_order_checkout_v2",
    "record_amuhon_order_checkout_session_v2",
    "apply_amuhon_stripe_checkout_paid_v2",
  ]) {
    const match = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i").exec(sql);
    assert.ok(match, `missing ${name}`);
    assert.match(match[0], /security definer/i, name);
    assert.match(match[0], /set search_path = pg_catalog, pg_temp/i, name);
    assert.match(match[0], /p_livemode boolean/i, name);
  }
  assert.match(sql, /where id = p_order_id for update/i);
  assert.match(sql, /target\.files_validated_at is null/i);
  assert.match(sql, /target\.amount_minor is distinct from expected_amount/i);
  assert.match(sql, /event_row\.livemode is distinct from p_livemode/i);
  assert.match(sql, /insert into public\.amuhon_stripe_webhook_events[\s\S]*?livemode/i);
});

test("all mode-aware RPCs are service-role only and legacy mutation RPCs are disabled", () => {
  for (const signature of [
    "begin_amuhon_order_checkout_v2(uuid, text, uuid, boolean)",
    "record_amuhon_order_checkout_session_v2(uuid, text, uuid, text, text, bigint, boolean)",
    "apply_amuhon_stripe_checkout_paid_v2(text, text, uuid, uuid, text, bigint, bigint, text, text, boolean)",
  ]) {
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escapedSignature} from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escapedSignature} to service_role`, "i"));
  }
  for (const name of ["begin_amuhon_order_checkout", "record_amuhon_order_checkout_session", "apply_amuhon_stripe_checkout_paid"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(`, "i"), name);
  }
  assert.match(sql, /revoke all on function public\.get_amuhon_order_checkout_status\(uuid, text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_amuhon_order_checkout_status\(uuid, text\) to service_role/i);
});
