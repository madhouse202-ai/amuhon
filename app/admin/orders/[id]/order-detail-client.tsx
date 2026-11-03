"use client";

import { useCallback, useEffect, useState } from "react";

type AdminOrderDetail = {
  id: string;
  orderNumber: string;
  title: string;
  works: Array<{ title: string; author: string }>;
  pageCount: number | null;
  amountYen: number | null;
  currency: string | null;
  paymentStatus: string;
  assetsVerified: boolean;
  canDownloadAssets: boolean;
  fulfillmentStatus: string;
  submittedAt: string | null;
  customer: { name: string; postalCode: string; prefecture: string; city: string; address: string; phone: string; email: string };
};

export function AdminOrderDetailClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "ログイン状態を確認してください。" : response.status === 403 ? "管理者として許可されていません。" : response.status === 404 ? "注文が見つかりません。" : "注文詳細を読み込めませんでした。");
    const data = await response.json() as { order?: AdminOrderDetail };
    if (!data.order || data.order.id !== orderId) throw new Error("注文詳細の形式を確認できませんでした。");
    setOrder(data.order);
  }, [orderId]);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "ログイン状態を確認してください。" : response.status === 403 ? "管理者として許可されていません。" : response.status === 404 ? "注文が見つかりません。" : "注文詳細を読み込めませんでした。");
        return response.json() as Promise<{ order?: AdminOrderDetail }>;
      })
      .then((data) => {
        if (!data.order || data.order.id !== orderId) throw new Error("注文詳細の形式を確認できませんでした。");
        if (active) setOrder(data.order);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "注文詳細を読み込めませんでした。"); });
    return () => { active = false; };
  }, [orderId]);

  async function markSubmitted() {
    if (busy || !order) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/submission`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error(response.status === 409 ? "決済済み・ファイル検証済みの注文だけ入稿済みにできます。" : "入稿状態を更新できませんでした。");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "入稿状態を更新できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  if (error && !order) return <p role="alert" className="mt-6 rounded bg-red-50 p-4 text-red-800">{error}</p>;
  if (!order) return <p className="mt-6 text-stone-600">注文を読み込み中…</p>;
  const yen = order.amountYen === null ? "未確定" : `${new Intl.NumberFormat("ja-JP").format(order.amountYen)}円`;

  return (
    <div className="mt-6 space-y-7">
      {error && <p role="alert" className="rounded bg-red-50 p-4 text-red-800">{error}</p>}
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="text-xl font-semibold">{order.title}</h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-stone-500">注文番号</dt><dd>{order.orderNumber}</dd></div>
          <div><dt className="text-xs text-stone-500">ページ数</dt><dd>{order.pageCount ?? "未確定"}ページ</dd></div>
          <div><dt className="text-xs text-stone-500">販売価格（税込・送料込み）</dt><dd>{yen}</dd></div>
          <div><dt className="text-xs text-stone-500">決済</dt><dd>{order.paymentStatus === "paid" ? "決済済み" : order.paymentStatus}</dd></div>
          <div><dt className="text-xs text-stone-500">入稿状態</dt><dd>{order.fulfillmentStatus === "submitted" ? "入稿済み" : "未入稿"}</dd></div>
          <div><dt className="text-xs text-stone-500">製本ファイル検証</dt><dd>{order.assetsVerified ? "検証済み" : "未検証"}</dd></div>
        </dl>
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">収録作品</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5">{order.works.map((work, index) => <li key={`${work.title}-${index}`}>{work.title}{work.author ? ` — ${work.author}` : ""}</li>)}</ol>
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">配送先</h2>
        <address className="mt-3 not-italic leading-7">
          {order.customer.name}<br />〒{order.customer.postalCode}<br />{order.customer.prefecture}{order.customer.city}{order.customer.address}<br />電話：{order.customer.phone}<br />メール：{order.customer.email}
        </address>
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">製本ファイル</h2>
        {order.canDownloadAssets ? <div className="mt-3 flex flex-wrap gap-4">
          <a className="underline" href={`/api/admin/orders/${encodeURIComponent(order.id)}/files/body_pdf`}>本文PDFをダウンロード</a>
          <a className="underline" href={`/api/admin/orders/${encodeURIComponent(order.id)}/files/cover_png`}>表紙PNGをダウンロード</a>
        </div> : <p className="mt-3 text-sm text-stone-600">決済済みかつファイル検証済みの注文のみダウンロードできます。</p>}
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">製本直送.comへの手動入稿</h2>
        {order.fulfillmentStatus === "submitted" ? <p className="mt-3">入稿済み{order.submittedAt ? `（${new Date(order.submittedAt).toLocaleString("ja-JP")}）` : ""}</p> : <button type="button" className="mt-3 rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50" disabled={!order.canDownloadAssets || busy} onClick={markSubmitted}>{busy ? "更新中…" : "入稿済みにする"}</button>}
        {!order.canDownloadAssets && order.fulfillmentStatus !== "submitted" && <p className="mt-2 text-sm text-amber-800">決済済み・ファイル検証済みになるまで入稿状態を更新できません。</p>}
      </section>
    </div>
  );
}
