import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getPublicSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const parsed = new URL(url);
    const allowedProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost");
    if (!allowedProtocol || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.origin !== url.replace(/\/$/, "")) return null;
    return { url, key };
  } catch {
    return null;
  }
}

export async function createSupabaseServerClient() {
  const config = getPublicSupabaseConfig();
  if (!config) return null;
  const cookieStore = await cookies();
  return createServerClient(config.url, config.key, {
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
