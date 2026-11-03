import { verifyStripeWebhookSignature } from "../../../../lib/stripe-webhook-signature.ts";
import { callOrderRpc, getSupabaseServerConfig } from "../../../../lib/order-checkout-server.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = 1_000_000;

function fail(status: number) {
  return Response.json({ received: false }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    const value = Number(length);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WEBHOOK_BYTES) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 10_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return null;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BYTES) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !webhookSecret.startsWith("whsec_")) return fail(503);
  const rawBody = await readLimitedBody(request);
  if (!rawBody || !verifyStripeWebhookSignature(rawBody, request.headers.get("stripe-signature"), webhookSecret)) return fail(400);

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400);
    event = parsed as Record<string, unknown>;
  } catch {
    return fail(400);
  }
  if (typeof event.id !== "string" || !/^evt_[A-Za-z0-9]+$/.test(event.id) || event.livemode !== false) return fail(400);
  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true, ignored: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
  const session = data?.object && typeof data.object === "object" ? data.object as Record<string, unknown> : null;
  const metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata as Record<string, unknown> : null;
  if (!session || !metadata || session.object !== "checkout.session" || session.livemode !== false || session.mode !== "payment" || session.payment_status !== "paid") return fail(400);
  const orderId = metadata.order_id;
  const attemptId = metadata.checkout_attempt_id;
  const sessionId = session.id;
  const paymentIntent = session.payment_intent;
  const amount = session.amount_total;
  const expiry = session.expires_at;
  if (!isUuid(orderId) || !isUuid(attemptId) || session.client_reference_id !== orderId ||
      typeof sessionId !== "string" || !/^cs_test_[A-Za-z0-9]+$/.test(sessionId) ||
      typeof paymentIntent !== "string" || !/^pi_[A-Za-z0-9]+$/.test(paymentIntent) ||
      !Number.isSafeInteger(amount) || !Number.isSafeInteger(expiry) || session.currency !== "jpy") return fail(400);

  const supabase = getSupabaseServerConfig();
  if (!supabase) return fail(503);
  try {
    const result = await callOrderRpc(supabase, "apply_amuhon_stripe_checkout_paid", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_order_id: orderId,
      p_checkout_attempt_id: attemptId,
      p_session_id: sessionId,
      p_session_expires_at_epoch: expiry,
      p_amount_total: amount,
      p_currency: session.currency,
      p_payment_intent_id: paymentIntent,
    });
    if (!result.ok || !result.data || !["paid", "duplicate"].includes(String(result.data.state))) return fail(500);
  } catch {
    return fail(500);
  }
  return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
}
