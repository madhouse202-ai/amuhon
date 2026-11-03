import { redirect } from "next/navigation";

import { AdminLogoutButton } from "./admin-logout-button.tsx";
import { AdminOrdersClient } from "./orders/orders-client.tsx";
import { requireAdmin } from "../../lib/admin-auth.ts";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const auth = await requireAdmin();
  if (!auth.allowed && auth.status === 401) redirect("/admin/login");
  if (!auth.allowed) {
    return <main className="mx-auto min-h-screen max-w-5xl px-6 py-12"><h1 className="text-2xl font-bold">管理機能を利用できません</h1><p className="mt-3 text-stone-600">管理者IDまたはSupabase Authのサーバー設定が未完了です。設定が確認できるまで注文データにはアクセスできません。</p></main>;
  }
  return <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
    <header className="flex items-center justify-between"><div><p className="text-sm text-stone-500">編む本 運営者用</p><h1 className="mt-1 text-3xl font-bold">注文管理</h1></div><AdminLogoutButton /></header>
    <AdminOrdersClient />
  </main>;
}
