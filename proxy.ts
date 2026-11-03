import type { NextRequest } from "next/server";

import { updateSupabaseAuthSession } from "./lib/supabase/proxy.ts";

export async function proxy(request: NextRequest) {
  return updateSupabaseAuthSession(request);
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
