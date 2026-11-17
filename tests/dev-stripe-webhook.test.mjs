import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalStripeTestConfiguration,
  LOCAL_WEBHOOK_TARGET,
  parseWebhookSigningSecret,
  stripeListenArguments,
} from "../scripts/dev-stripe-webhook.mjs";

test("local webhook runner parses the Stripe CLI signing secret without printing or persisting it", () => {
  assert.equal(parseWebhookSigningSecret("Ready! Your webhook signing secret is whsec_testOnly123 (^C to quit)"), "whsec_testOnly123");
  assert.equal(parseWebhookSigningSecret("Stripe CLI is listening but no signing secret was supplied"), null);
});

test("local webhook runner has a fixed localhost target and only forwards the app's current card event", () => {
  assert.equal(LOCAL_WEBHOOK_TARGET, "http://localhost:3000/api/webhooks/stripe");
  assert.deepEqual(stripeListenArguments(), ["listen", "--forward-to", LOCAL_WEBHOOK_TARGET, "--events", "checkout.session.completed"]);
});

test("local webhook runner refuses live mode, non-local app origins, and non-staging Supabase URLs", () => {
  const staging = {
    STRIPE_MODE: "test",
    STRIPE_SECRET_KEY: "sk_test_mock_only",
    ORDER_APP_ORIGIN: "http://localhost:3000",
    SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co",
  };
  assert.equal(isLocalStripeTestConfiguration(staging), true);
  assert.equal(isLocalStripeTestConfiguration({ ...staging, STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_live_mock_only" }), false);
  assert.equal(isLocalStripeTestConfiguration({ ...staging, ORDER_APP_ORIGIN: "https://example.test" }), false);
  assert.equal(isLocalStripeTestConfiguration({ ...staging, SUPABASE_URL: "https://production-project.supabase.co" }), false);
  assert.equal(isLocalStripeTestConfiguration({ ...staging, SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co:8443" }), false);
  assert.equal(isLocalStripeTestConfiguration({ ...staging, SUPABASE_URL: "https://ahxnmkuvdpzctcwcyadl.supabase.co/proxy" }), false);
});
