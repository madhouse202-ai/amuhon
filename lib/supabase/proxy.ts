import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

export async function updateSupabaseAuthSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = getPublicSupabaseConfig();
  if (!config) return response;

  const supabase = createServerClient(config.url, config.key, {
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
