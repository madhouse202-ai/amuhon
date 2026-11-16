import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
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

export async function updateSupabaseAuthSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = getPublicSupabaseConfig();
  if (!config) return response;

  const supabase = createServerClient(config.url, config.credential.apiKey, {
    global: { fetch: createSupabasePublicFetch(config.credential) },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });
  await supabase.auth.getClaims();
  return response;
}
