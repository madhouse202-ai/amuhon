"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseBrowserClient } from "../../../lib/supabase/client.ts";

export function AdminLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setError("ログインサービスが設定されていません。");
      setBusy(false);
      return;
    }
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError("ログインできませんでした。入力内容を確認してください。");
        return;
      }
      setPassword("");
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("ログインサービスに接続できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={submit}>
      <label className="block text-sm font-medium text-stone-800">
        メールアドレス
        <input className="mt-1 w-full rounded border border-stone-300 px-3 py-2" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label className="block text-sm font-medium text-stone-800">
        パスワード
        <input className="mt-1 w-full rounded border border-stone-300 px-3 py-2" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button className="rounded bg-stone-900 px-4 py-2 font-medium text-white disabled:opacity-50" disabled={busy} type="submit">
        {busy ? "確認中…" : "ログイン"}
      </button>
      <p className="text-xs text-stone-500">管理者アカウントは運営者が別途作成します。ここから新規登録はできません。</p>
    </form>
  );
}
