import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const sql = await read("supabase/migrations/20261125000100_customer_order_notifications.sql");

test("customer outbox is unique per order and event, private, disabled by default, and never backfilled", () => {
  assert.match(sql, /primary key\s*\(order_id, notification_type\)/i);
  assert.match(sql, /notification_type in \('order_confirmed', 'order_shipped'\)/i);
  assert.match(sql, /create table public\.amuhon_customer_order_notification_settings[\s\S]*?enabled boolean not null default false/i);
  assert.match(sql, /values \(true, false\)/i);
  assert.match(sql, /alter table public\.amuhon_customer_order_notifications enable row level security/i);
  assert.match(sql, /revoke all on public\.amuhon_customer_order_notifications from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on public\.amuhon_customer_order_notification_settings from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /insert into public\.amuhon_customer_order_notifications\s*\([^)]*\)\s*select/i);
  assert.match(sql, /on conflict \(order_id, notification_type\) do nothing/i);
});

test("only future paid and first shipped transitions create events; submitted alone never creates shipment mail", () => {
  assert.match(sql, /after update of status on public\.amuhon_orders[\s\S]*?new\.status = 'paid'[\s\S]*?execute function public\.enqueue_amuhon_customer_order_confirmed_notification_v1/i);
  assert.match(sql, /after update of printer_submission_status on public\.amuhon_orders[\s\S]*?old\.printer_submission_status = 'submitted'[\s\S]*?new\.printer_submission_status = 'shipped'[\s\S]*?execute function public\.enqueue_amuhon_customer_order_shipped_notification_v1/i);
  assert.doesNotMatch(sql, /new\.printer_submission_status\s*=\s*'submitted'[\s\S]{0,250}enqueue_amuhon_customer_order_shipped_notification_v1/i);
  assert.match(sql, /case when coalesce\(\(select enabled from public\.amuhon_customer_order_notification_settings where singleton\), false\)\s+then 'queued' else 'suppressed' end/i);
  assert.match(sql, /status = 'suppressed' then return jsonb_build_object\('state', 'suppressed'\)/i);
});

test("customer claims require a paid saved order, verified event type, valid saved email and title", () => {
  const start = sql.indexOf("function public.claim_amuhon_customer_order_notification_v1");
  const end = sql.indexOf("$$;", start);
  const claim = sql.slice(start, end);
  assert.match(claim, /target\.status is distinct from 'paid'/i);
  assert.match(claim, /p_notification_type = 'order_shipped' and target\.printer_submission_status is distinct from 'shipped'/i);
  assert.match(claim, /email_value := target\.customer ->> 'email'/i);
  assert.match(claim, /recipientEmail', email_value/i);
  assert.match(claim, /target\.currency is distinct from 'JPY'/i);
  assert.match(claim, /target\.stripe_payment_id is null/i);
  assert.match(claim, /target\.stripe_payment_id !~ '\^pi_\[A-Za-z0-9\]\+\$'/i);
  assert.match(claim, /target\.book_snapshot ->> 'title'/i);
  assert.match(claim, /for share/i);
});

test("customer retry lifecycle has lease checks, an eight-attempt cap and a 23-hour window", () => {
  assert.match(sql, /status = 'sending' and lease_expires_at <= clock_timestamp\(\)/i);
  assert.match(sql, /notification\.first_attempt_at <= clock_timestamp\(\) - interval '23 hours'/i);
  assert.match(sql, /notification\.attempt_count >= 8/i);
  assert.match(sql, /where order_id = p_order_id and notification_type = p_notification_type and\s+status = 'sending' and lease_id = p_lease_id/i);
  assert.match(sql, /least\(3600, 30 \* \(2 \^ greatest\(notification\.attempt_count - 1, 0\)\)::integer\)/i);
  assert.match(sql, /customer_recipient_not_allowlisted/);
  assert.match(sql, /customer_delivery_configuration_invalid/);
});

test("shared claim skips locked rows and schedules operator and customer queues by due time", () => {
  const start = sql.indexOf("function public.claim_next_amuhon_email_notification_v1");
  const end = sql.indexOf("$$;", start);
  const claim = sql.slice(start, end);
  assert.equal((claim.match(/for update skip locked limit 1/gi) ?? []).length, 2);
  assert.match(claim, /paid_due_at <= customer_due_at/i);
  assert.match(claim, /claim_amuhon_order_paid_notification_v1\(paid_order_id, p_lease_seconds\)/i);
  assert.match(claim, /claim_amuhon_customer_order_notification_v1\(customer_order_id, customer_type, p_lease_seconds\)/i);
});

test("all RPCs are SECURITY DEFINER with fixed search_path and only service-role execution", () => {
  const signatures = [
    ["claim_amuhon_customer_order_notification_v1", "uuid, text, integer"],
    ["complete_amuhon_customer_order_notification_v1", "uuid, text, uuid, text"],
    ["fail_amuhon_customer_order_notification_v1", "uuid, text, uuid, text"],
    ["claim_next_amuhon_email_notification_v1", "integer"],
    ["get_amuhon_order_paid_notification_webhook_status_v1", "uuid"],
    ["get_amuhon_admin_order_customer_notification_status_v1", "uuid"],
  ];
  for (const [name, args] of signatures) {
    const start = sql.indexOf(`function public.${name}`);
    assert.notEqual(start, -1, `${name} exists`);
    const body = sql.slice(start, sql.indexOf("$$;", start) + 3);
    assert.match(body, /security definer/i, name);
    assert.match(body, /set search_path = pg_catalog, pg_temp/i, name);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(${args.replaceAll(", ", "\\s*,\\s*")}\\) to service_role`, "i"), name);
  }
  assert.match(sql, /revoke all on function public\.claim_amuhon_customer_order_notification_v1\(uuid, text, integer\) from public, anon, authenticated/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
});

test("webhook and admin status RPCs expose only states and never customer email or provider identifiers", () => {
  const webhookStart = sql.indexOf("function public.get_amuhon_order_paid_notification_webhook_status_v1");
  const webhookEnd = sql.indexOf("$$;", webhookStart);
  const webhook = sql.slice(webhookStart, webhookEnd);
  assert.match(webhook, /'customerState', coalesce\(customer_status, 'missing'\)/i);
  assert.doesNotMatch(webhook, /recipientEmail|customer ->>|resend_email_id/i);
  const adminStart = sql.indexOf("function public.get_amuhon_admin_order_customer_notification_status_v1");
  const adminEnd = sql.indexOf("$$;", adminStart);
  const admin = sql.slice(adminStart, adminEnd);
  assert.match(admin, /'orderConfirmed'/i);
  assert.match(admin, /'orderShipped'/i);
  assert.doesNotMatch(admin, /recipientEmail|customer ->>|resend_email_id/i);
});
