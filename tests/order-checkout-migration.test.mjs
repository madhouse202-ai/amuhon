import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20261103000100_order_stripe_checkout.sql", import.meta.url), "utf8");

test("checkout pricing is server-side, bounded to the published page bands, and requires finalized assets", () => {
  assert.match(sql, /body_pdf_page_count between 24 and 100 then 1980/i);
  assert.match(sql, /body_pdf_page_count between 101 and 150 then 2280/i);
  assert.match(sql, /body_pdf_page_count between 151 and 200 then 2580/i);
  assert.match(sql, /body_pdf_page_count between 201 and 250 then 2880/i);
  assert.match(sql, /body_pdf_page_count between 251 and 300 then 3180/i);
  assert.match(sql, /files_validated_at is null/i);
  assert.match(sql, /ORDER_PAGE_COUNT_UNSUPPORTED/);
  assert.match(sql, /ORDER_PRICE_MISMATCH/);
  assert.match(sql, /status = 'ready_for_payment'/i);
  assert.match(sql, /target\.amount_minor is distinct from quoted_amount or target\.currency is distinct from 'JPY' or target\.shipping_minor is distinct from 0/i);
  assert.doesNotMatch(sql, /between\s+301\s+and|when\s+true\s+then/i);
});

test("RPCs are SECURITY DEFINER with fixed search paths and service-role-only execute", () => {
  const definitions = [...sql.matchAll(/create or replace function public\.(get_amuhon_order_checkout_status|begin_amuhon_order_checkout|record_amuhon_order_checkout_session|apply_amuhon_stripe_checkout_paid)\(([\s\S]*?\n\$\$;)/gi)];
  assert.equal(definitions.length, 4);
  for (const [, name, definition] of definitions) {
    assert.match(definition, /security definer/i, name);
    assert.match(definition, /set search_path = pg_catalog, pg_temp/i, name);
  }
  assert.equal((sql.match(/grant execute on function public\./gi) ?? []).length, 4);
  assert.match(sql, /revoke all on public\.amuhon_stripe_webhook_events from public, anon, authenticated, service_role/i);
  assert.match(sql, /enable row level security/i);
});

test("signed payment processing has event idempotency and never depends on browser return URLs", () => {
  assert.match(sql, /amuhon_stripe_webhook_events[\s\S]*?event_id text primary key/i);
  assert.match(sql, /select \* into event_row from public\.amuhon_stripe_webhook_events where event_id = p_event_id/i);
  assert.match(sql, /event_row\.event_type <> 'checkout\.session\.completed'/i);
  assert.match(sql, /target\.status = 'paid'[\s\S]*?target\.stripe_checkout_session_id is distinct from p_session_id/i);
  assert.match(sql, /p_amount_total is distinct from expected_amount/i);
  assert.match(sql, /target\.amount_minor is distinct from expected_amount/i);
  assert.match(sql, /target\.stripe_checkout_attempt_id is distinct from p_checkout_attempt_id/i);
  assert.match(sql, /status = 'paid'/i);
});

test("success and cancel pages can only display the order status returned by the capability-protected status API", async () => {
  const resultUi = await readFile(new URL("../app/order/payment-result.tsx", import.meta.url), "utf8");
  const successPage = await readFile(new URL("../app/order/success/page.tsx", import.meta.url), "utf8");
  const cancelPage = await readFile(new URL("../app/order/cancel/page.tsx", import.meta.url), "utf8");
  assert.match(resultUi, /\/api\/orders\/\$\{encodeURIComponent\(orderId\)\}\/status/);
  assert.match(resultUi, /state\?\.status === "paid"/);
  assert.doesNotMatch(resultUi, /payment_status|apply_amuhon_stripe_checkout_paid|session_id/);
  assert.match(successPage, /order_id/);
  assert.doesNotMatch(successPage, /session_id|paid/);
  assert.match(cancelPage, /order_id/);
  assert.doesNotMatch(cancelPage, /session_id|paid/);
});
