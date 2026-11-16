import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createSupabasePublicFetch, getSupabasePublicCredential, type SupabasePublicCredential } from "../supabase-public-credential.ts";

function getPublicSupabaseConfig(): { url: string; credential: SupabasePublicCredential } | null {
  const url = process.env.SUPABASE_URL;
  const credential = getSupabasePublicCredential(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  if (!url || !credential) return null;
  try {
    const parsed = new URL(url);
    const allowedProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost");
    if (!allowedProtocol || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.origin !== url.replace(/\/$/, "")) return null;
    return { url, credential };
  } catch {
    return null;
  }
}

export async function createSupabaseServerClient() {
  const config = getPublicSupabaseConfig();
  if (!config) return null;
  const cookieStore = await cookies();
  return createServerClient(config.url, config.credential.apiKey, {
    global: { fetch: createSupabasePublicFetch(config.credential) },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes these before protected routes.
        }
      },
    },
  });
}
