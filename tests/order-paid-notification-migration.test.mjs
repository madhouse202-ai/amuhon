import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20261123000100_order_paid_notification_outbox.sql", import.meta.url), "utf8");

test("paid notification outbox is private, unique per order, and has no historical backfill", () => {
  assert.match(sql, /order_id uuid primary key references public\.amuhon_orders\(id\) on delete restrict/i);
  assert.match(sql, /alter table public\.amuhon_order_paid_notifications enable row level security/i);
  assert.match(sql, /revoke all on public\.amuhon_order_paid_notifications from public, anon, authenticated, service_role/i);
  assert.match(sql, /after update of status on public\.amuhon_orders[\s\S]*?when \(old\.status is distinct from new\.status and new\.status = 'paid'\)/i);
  assert.match(sql, /on conflict \(order_id\) do nothing/i);
  assert.doesNotMatch(sql, /insert into public\.amuhon_order_paid_notifications\s+select/i);
  assert.match(sql, /create table public\.amuhon_order_paid_notification_settings/i);
  assert.match(sql, /values \(true, false\)/i);
  assert.match(sql, /case when coalesce\(\(select enabled from public\.amuhon_order_paid_notification_settings where singleton\), false\)\s+then 'queued' else 'suppressed' end/i);
  assert.match(sql, /status in \('queued', 'sending', 'sent', 'needs_review', 'suppressed'\)/i);
});

test("notification RPCs are SECURITY DEFINER with a fixed search_path and service-only execution", () => {
  for (const name of [
    "claim_amuhon_order_paid_notification_v1",
    "claim_next_amuhon_order_paid_notification_v1",
    "complete_amuhon_order_paid_notification_v1",
    "fail_amuhon_order_paid_notification_v1",
    "get_amuhon_order_paid_notification_webhook_status_v1",
    "get_amuhon_admin_order_paid_notification_status_v1",
  ]) {
    const start = sql.indexOf(`function public.${name}`);
    assert.notEqual(start, -1, `${name} exists`);
    const body = sql.slice(start, sql.indexOf("$$;", start) + 3);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = pg_catalog, pg_temp/i);
  }
  assert.match(sql, /grant execute on function public\.claim_amuhon_order_paid_notification_v1\(uuid, integer\) to service_role/i);
  assert.match(sql, /grant execute on function public\.claim_next_amuhon_order_paid_notification_v1\(integer\) to service_role/i);
  assert.match(sql, /grant execute on function public\.complete_amuhon_order_paid_notification_v1\(uuid, uuid, text\) to service_role/i);
  assert.match(sql, /grant execute on function public\.fail_amuhon_order_paid_notification_v1\(uuid, uuid, text\) to service_role/i);
  assert.match(sql, /grant execute on function public\.get_amuhon_order_paid_notification_webhook_status_v1\(uuid\) to service_role/i);
  assert.match(sql, /grant execute on function public\.get_amuhon_admin_order_paid_notification_status_v1\(uuid\) to service_role/i);
  assert.match(sql, /from public, anon, authenticated/i);
});

test("global worker claim is single-row, concurrency-safe, due-only, and respects the DB switch", () => {
  const start = sql.indexOf("function public.claim_next_amuhon_order_paid_notification_v1");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(body, /if not coalesce\(\(select enabled from public\.amuhon_order_paid_notification_settings where singleton\), false\)/i);
  assert.match(body, /status = 'queued' and next_attempt_at <= clock_timestamp\(\)/i);
  assert.match(body, /status = 'sending' and lease_expires_at <= clock_timestamp\(\)/i);
  assert.doesNotMatch(body, /status = 'suppressed'/i, "suppressed orders never enter the automatic claim set");
  assert.match(body, /order by next_attempt_at, created_at, order_id\s+for update skip locked\s+limit 1/i);
  assert.match(body, /claim_amuhon_order_paid_notification_v1\(candidate_order_id, p_lease_seconds\)/i);
  assert.match(sql, /comment on table public\.amuhon_order_paid_notification_settings is/i);
  assert.doesNotMatch(sql, /comment on public\.amuhon_order_paid_notification_settings/i);
});

test("claim validates a paid verified order and stops retries before provider idempotency expires", () => {
  assert.match(sql, /target\.status is distinct from 'paid'/i);
  assert.match(sql, /target\.files_validated_at is null/i);
  assert.match(sql, /target\.amount_minor is distinct from expected_amount/i);
  assert.match(sql, /target\.currency is distinct from 'JPY'/i);
  assert.match(sql, /notification\.first_attempt_at <= clock_timestamp\(\) - interval '23 hours'/i);
  assert.match(sql, /attempt_count >= 8/i);
  const claimStart = sql.indexOf("function public.claim_amuhon_order_paid_notification_v1");
  const claimEnd = sql.indexOf("$$;", claimStart);
  const claimBody = sql.slice(claimStart, claimEnd);
  assert.doesNotMatch(claimBody, /target\.customer|customer\s*,/i);
});

test("direct per-order claims permanently exclude suppressed notifications before checking the switch", () => {
  const claimStart = sql.indexOf("function public.claim_amuhon_order_paid_notification_v1");
  const claimEnd = sql.indexOf("$$;", claimStart);
  const claimBody = sql.slice(claimStart, claimEnd);
  const suppressedGuard = /if notification\.status = 'suppressed' then\s+return jsonb_build_object\('state', 'suppressed'\);\s+end if;/i;
  const guardMatch = claimBody.match(suppressedGuard);

  assert.ok(guardMatch, "suppressed status returns without claiming the row");
  assert.ok(
    guardMatch.index < claimBody.indexOf("select enabled into notifications_enabled"),
    "the permanent exclusion applies even when notifications are enabled later",
  );
  assert.ok(guardMatch.index < claimBody.indexOf("notification_lease := pg_catalog.gen_random_uuid()"));
});

test("lease completion and failure updates require the active lease", () => {
  assert.match(sql, /where order_id = p_order_id and status = 'sending' and lease_id = p_lease_id/i);
  assert.match(sql, /where order_id = p_order_id and status = 'sending' and lease_id = p_lease_id\s+for update/i);
  assert.match(sql, /least\(3600, 30 \* \(2 \^ greatest\(notification\.attempt_count - 1, 0\)\)::integer\)/i);
});
