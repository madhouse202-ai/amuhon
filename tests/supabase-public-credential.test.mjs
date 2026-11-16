import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";

import {
  createSupabasePublicFetch,
  getSupabasePublicCredential,
} from "../lib/supabase-public-credential.ts";

const PUBLISHABLE_KEY = "sb_publishable_mock-only-not-a-real-key";

test("new publishable key wins and a malformed configured value fails closed", () => {
  assert.deepEqual(getSupabasePublicCredential(PUBLISHABLE_KEY), { apiKey: PUBLISHABLE_KEY });
  assert.equal(getSupabasePublicCredential("wrong-format"), null);
  assert.equal(getSupabasePublicCredential(` ${PUBLISHABLE_KEY}`), null);
});

test("missing publishable key fails closed", () => {
  assert.equal(getSupabasePublicCredential(undefined), null);
  assert.equal(getSupabasePublicCredential(""), null);
});

test("publishable fetch removes only its own SDK Bearer fallback and keeps user JWT", async () => {
  const calls = [];
  const fetchMock = async (input, init) => {
    calls.push({ input, init });
    return new Response(null, { status: 204 });
  };
  const credential = getSupabasePublicCredential(PUBLISHABLE_KEY);
  assert.ok(credential);
  const publicFetch = createSupabasePublicFetch(credential, fetchMock);

  await publicFetch("https://project.supabase.co/rest/v1/example", {
    headers: { Authorization: `Bearer ${PUBLISHABLE_KEY}` },
  });
  assert.equal(calls[0].init.headers.get("apikey"), PUBLISHABLE_KEY);
  assert.equal(calls[0].init.headers.has("authorization"), false);

  const userJwt = "eyJhbGciOiJIUzI1NiJ9.user-session.signature";
  await publicFetch("https://project.supabase.co/rest/v1/example", {
    headers: { Authorization: `Bearer ${userJwt}` },
  });
  assert.equal(calls[1].init.headers.get("apikey"), PUBLISHABLE_KEY);
  assert.equal(calls[1].init.headers.get("authorization"), `Bearer ${userJwt}`);
});

test("installed supabase-js REST requests use publishable apikey without API-key Bearer", async () => {
  const requests = [];
  const credential = getSupabasePublicCredential(PUBLISHABLE_KEY);
  assert.ok(credential);
  const client = createClient("https://project.supabase.co", credential.apiKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: createSupabasePublicFetch(credential, async (input, init) => {
        requests.push({ input, init });
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    },
  });

  const { error } = await client.from("mock_table").select("id").limit(0);
  assert.equal(error, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.get("apikey"), PUBLISHABLE_KEY);
  assert.equal(requests[0].init.headers.has("authorization"), false);
});

test("installed supabase-js Auth requests use publishable apikey without API-key Bearer", async () => {
  let captured;
  const credential = getSupabasePublicCredential(PUBLISHABLE_KEY);
  assert.ok(credential);
  const client = createClient("https://project.supabase.co", credential.apiKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: createSupabasePublicFetch(credential, async (input, init) => {
        captured = { input, init };
        return new Response(JSON.stringify({ message: "mock rejection" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }),
    },
  });

  await client.auth.signInWithPassword({ email: "mock@example.test", password: "mock-only-password" });
  assert.ok(captured);
  assert.equal(captured.init.headers.get("apikey"), PUBLISHABLE_KEY);
  assert.equal(captured.init.headers.has("authorization"), false);
});

test("browser, cookie Auth, proxy, and TUS upload paths select the publishable key", async () => {
  const files = [
    ["../lib/supabase/client.ts", await readFile(new URL("../lib/supabase/client.ts", import.meta.url), "utf8")],
    ["../lib/supabase/server.ts", await readFile(new URL("../lib/supabase/server.ts", import.meta.url), "utf8")],
    ["../lib/supabase/proxy.ts", await readFile(new URL("../lib/supabase/proxy.ts", import.meta.url), "utf8")],
    ["../app/order/page.tsx", await readFile(new URL("../app/order/page.tsx", import.meta.url), "utf8")],
  ];

  for (const [path, source] of files) {
    assert.match(source, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/, path);
    assert.doesNotMatch(source, /NEXT_PUBLIC_SUPABASE_ANON_KEY/, path);
    assert.match(source, /getSupabasePublicCredential/, path);
  }
  assert.match(files[0][1], /createSupabasePublicFetch\(credential\)/, files[0][0]);
  for (const [path, source] of files.slice(1, 3)) {
    assert.match(source, /createSupabasePublicFetch\(config\.credential\)/, path);
  }
  assert.match(files[3][1], /createOrderTusHeaders\(publicCredential\.apiKey, signature\)/);
  const helper = await readFile(new URL("../lib/supabase-public-credential.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /NEXT_PUBLIC_SUPABASE_ANON_KEY|legacy_anon/);
});
