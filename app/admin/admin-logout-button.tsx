"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "../../lib/supabase/client.ts";

export function AdminLogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    if (busy) return;
    setBusy(true);
    const supabase = createSupabaseBrowserClient();
    if (supabase) await supabase.auth.signOut().catch(() => undefined);
    router.replace("/admin/login");
    router.refresh();
  }
  return <button className="text-sm underline disabled:opacity-50" type="button" onClick={logout} disabled={busy}>{busy ? "ログアウト中…" : "ログアウト"}</button>;
}
