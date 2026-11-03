import Link from "next/link";

import { AdminLoginForm } from "./login-form.tsx";

export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  return (
    <main className="mx-auto min-h-screen max-w-xl px-6 py-16">
      <p className="text-sm text-stone-500">編む本 運営者用</p>
      <h1 className="mt-2 text-3xl font-bold">管理ログイン</h1>
      <p className="mt-3 text-sm text-stone-600">Supabase Authでログインします。管理者として許可されたアカウントだけが注文情報を閲覧できます。</p>
      <AdminLoginForm />
      <Link className="mt-8 inline-block text-sm underline" href="/">トップへ戻る</Link>
    </main>
  );
}
