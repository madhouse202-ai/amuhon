"use client";

import { createBrowserClient } from "@supabase/ssr";
import { createSupabasePublicFetch, getSupabasePublicCredential } from "../supabase-public-credential.ts";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const credential = getSupabasePublicCredential(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  if (!url || !credential) return null;
  try {
    const parsed = new URL(url);
    const allowedProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost");
    if (!allowedProtocol || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.origin !== url.replace(/\/$/, "")) return null;
    return createBrowserClient(url, credential.apiKey, {
      global: { fetch: createSupabasePublicFetch(credential) },
    });
  } catch {
    return null;
  }
}
