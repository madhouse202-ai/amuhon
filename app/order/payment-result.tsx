"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type CheckoutState = {
  status?: string;
  pageCount?: number | null;
  filesVerified?: boolean;
  quotedAmountYen?: number | null;
  currency?: string | null;
};

export default function PaymentResult({ mode, orderId: rawOrderId }: { mode: "success" | "cancel"; orderId?: string }) {
  const router = useRouter();
  const orderId = rawOrderId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawOrderId)
    ? rawOrderId : null;
  const [state, setState] = useState<CheckoutState | null>(null);
  const [message, setMessage] = useState("");
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    let active = true;
    let attempts = 0;
    const load = async () => {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
          cache: "no-store", credentials: "same-origin",
        });
        if (!response.ok) throw new Error("status_unavailable");
        const result = await response.json() as CheckoutState;
        if (active) setState(result);
      } catch {
        if (active) setMessage("注文状況を確認できません。画面を再読み込みしてください。");
      }
    };
    void load();
    const timer = window.setInterval(() => {
      attempts += 1;
      if (state?.status === "paid" || attempts >= 20) {
        window.clearInterval(timer);
        return;
      }
      void load();
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [orderId, state?.status]);

  async function reopenCheckout() {
    if (!orderId || retrying) return;
    setRetrying(true);
    setMessage("");
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin",
      });
      const result = await response.json() as { checkoutUrl?: unknown; alreadyPaid?: boolean; error?: string };
      if (response.ok && result.alreadyPaid === true) {
        router.replace(`/order/success?order_id=${encodeURIComponent(orderId)}`);
        return;
      }
      if (!response.ok || typeof result.checkoutUrl !== "string") throw new Error(result.error ?? "決済画面を開けませんでした。");
      const url = new URL(result.checkoutUrl);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("決済画面の接続先を確認できません。");
      window.location.assign(url.toString());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "決済画面を開けませんでした。");
      setRetrying(false);
    }
  }

  const paid = state?.status === "paid";
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-stone-800">
      <h1 className="text-3xl font-bold">{paid ? "お支払いを確認しました" : mode === "success" ? "決済結果を確認しています" : "決済画面から戻りました"}</h1>
      {!orderId && <p className="mt-5">注文情報を確認できません。注文画面から状態をご確認ください。</p>}
      {orderId && !paid && <p className="mt-5 rounded-lg bg-amber-50 p-4">決済サービスから戻ったことだけでは支払済みになりません。署名を確認した決済通知を受信後、注文状況を更新します。</p>}
      {paid && <p className="mt-5 rounded-lg bg-emerald-50 p-4">Stripeのテスト決済成功をサーバーで確認しました。製本会社への入稿・製本手配はまだ手動です。</p>}
      {state?.filesVerified && Number.isSafeInteger(state.quotedAmountYen) && (
        <p className="mt-4">本文 {state.pageCount}ページ・税込送料込み {new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(state.quotedAmountYen as number)}</p>
      )}
      {message && <p className="mt-4 text-red-700" role="alert">{message}</p>}
      {mode === "cancel" && orderId && !paid && (
        <button className="mt-6 rounded-lg bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => void reopenCheckout()} disabled={retrying}>
          {retrying ? "決済画面を確認中……" : "同じ注文の決済を再開する"}
        </button>
      )}
      {mode === "success" && orderId && !paid && <p className="mt-4 text-sm text-stone-600">決済通知を待っています。ページを閉じても、注文状態はサーバー側で確認されます。</p>}
      <Link className="mt-8 block underline" href="/">トップページへ戻る</Link>
    </main>
  );
}
