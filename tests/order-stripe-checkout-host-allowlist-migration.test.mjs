import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20261115000100_order_stripe_checkout_host_allowlist.sql", import.meta.url), "utf8");

function functionSql(name) {
  const match = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "i").exec(sql);
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("checkout host allowlist is database-owned, exact-host-only, and inaccessible directly", () => {
  assert.match(sql, /create table public\.amuhon_stripe_checkout_allowed_hosts/i);
  assert.match(sql, /hostname text primary key/i);
  assert.match(sql, /hostname = lower\(hostname\)/i);
  assert.match(sql, /split_part\(hostname, '\.', array_length\(string_to_array\(hostname, '\.'\), 1\)\) ~ '\^\[a-z\]'/i);
  assert.match(sql, /hostname !~ '\^\[0-9\]\+\(\[\.\]\[0-9\]\+\)\{3\}\$'/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.amuhon_stripe_checkout_allowed_hosts from public, anon, authenticated, service_role/i);
  assert.match(sql, /values \('checkout\.stripe\.com', true\)/i);
  assert.doesNotMatch(sql, /grant\s+(select|insert|update|delete|all)[\s\S]{0,100}amuhon_stripe_checkout_allowed_hosts[\s\S]{0,100}(anon|authenticated|service_role)/i);
});

test("allowlist read RPC is read-only, SECURITY DEFINER, fixed search_path, and service-role-only", () => {
  const definition = functionSql("get_amuhon_stripe_checkout_allowed_hosts_v1");
  assert.match(definition, /returns jsonb/i);
  assert.match(definition, /language sql\s+stable\s+security definer/i);
  assert.match(definition, /set search_path = pg_catalog, pg_temp/i);
  assert.match(definition, /jsonb_agg\(hostname order by hostname\)/i);
  assert.match(definition, /where enabled is true/i);
  assert.doesNotMatch(definition, /\b(insert|update|delete|truncate)\b/i);
  assert.match(sql, /revoke all on function public\.get_amuhon_stripe_checkout_allowed_hosts_v1\(\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_amuhon_stripe_checkout_allowed_hosts_v1\(\) to service_role/i);
});

test("replacement record RPC matches the app URL policy and retains checkout safeguards", () => {
  const definition = functionSql("record_amuhon_order_checkout_session_v2");
  assert.match(definition, /security definer/i);
  assert.match(definition, /set search_path = pg_catalog, pg_temp/i);
  assert.ok(definition.includes("p_session_url !~* '^https://[a-z0-9.-]+(:443)?/[^[:space:]]*$'"));
  assert.match(definition, /length\(p_session_url\) > 4096/i);
  assert.match(definition, /position\(chr\(92\) in p_session_url\) > 0/i);
  assert.ok(definition.includes("regexp_match(p_session_url, '^https://([A-Za-z0-9.-]+)', 'i')"));
  assert.match(definition, /where hostname = session_host and enabled is true/i);
  assert.doesNotMatch(definition, /\/c\/pay\//i, "no undocumented Stripe pathname is pinned");
  assert.match(definition, /session_host is null or not exists/i);
  assert.match(definition, /p_session_id !~ '\^cs_test_/i);
  assert.match(definition, /p_session_id !~ '\^cs_live_/i);
  assert.match(definition, /session_expiry <= now\(\)/i);
  assert.match(definition, /stripe_checkout_livemode is distinct from p_livemode/i);
  assert.match(definition, /select \* into target from public\.amuhon_orders where id = p_order_id for update/i);
  assert.match(definition, /target\.upload_token_hash is distinct from p_upload_token_hash/i);
  assert.match(definition, /between 24 and 100 then 1980/i);
  assert.match(definition, /target\.amount_minor is distinct from expected_amount/i);
  assert.match(definition, /target\.stripe_checkout_attempt_id is distinct from p_checkout_attempt_id/i);
  assert.match(definition, /target\.status not in \('ready_for_payment', 'paid'\)/i);
  assert.match(sql, /revoke all on function public\.record_amuhon_order_checkout_session_v2\(uuid, text, uuid, text, text, bigint, boolean\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.record_amuhon_order_checkout_session_v2\(uuid, text, uuid, text, text, bigint, boolean\) to service_role/i);
});

test("migration requests a PostgREST schema-cache reload after defining the RPCs", () => {
  assert.match(sql, /notify pgrst, 'reload schema';\s*$/i);
  assert.ok(sql.indexOf("notify pgrst, 'reload schema';") > sql.indexOf("grant execute on function public.record_amuhon_order_checkout_session_v2"));
});
