"use client";

import { useCallback, useEffect, useState } from "react";
import { calculateSpineWidthMm } from "../../../../lib/production.ts";

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
  productionReadiness?: {
    rightsApproved: boolean;
    assetsReady: boolean;
    renderState: string;
    pageCount: number | null;
    spineWidthMm: number | null;
    fulfillmentStatus: string;
    printerOrderNumber: string | null;
    submittedAt: string | null;
  };
  fulfillmentAudit?: Array<{
    from: string;
    to: string;
    printerOrderNumber: string | null;
    adminUserId: string;
    createdAt: string;
  }>;
  pdfRenderJob?: {
    state: "not_applicable" | "not_queued" | "queued" | "rendering" | "succeeded" | "failed" | "unavailable";
    attemptCount?: number;
    errorCode?: string;
  };
  paidNotification?: {
    state: "not_created" | "queued" | "sending" | "sent" | "needs_review" | "suppressed" | "unavailable";
    attemptCount?: number;
    errorCode?: string;
    nextAttemptAt?: string;
    sentAt?: string;
  };
  customer: { name: string; postalCode: string; prefecture: string; city: string; address: string; phone: string; email: string };
};

function recommendedNextStatus(status: string): string {
  return status === "not_submitted" ? "processing" :
    status === "processing" ? "submitted" :
      status === "on_hold" ? "processing" :
        status === "submitted" ? "shipped" : "shipped";
}

export function AdminOrderDetailClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextStatus, setNextStatus] = useState("processing");
  const [printerOrderNumber, setPrinterOrderNumber] = useState("");
  const [vendorOrderConfirmed, setVendorOrderConfirmed] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(response.status === 401 ? "ログイン状態を確認してください。" : response.status === 403 ? "管理者として許可されていません。" : response.status === 404 ? "注文が見つかりません。" : "注文詳細を読み込めませんでした。");
    const data = await response.json() as { order?: AdminOrderDetail };
    if (!data.order || data.order.id !== orderId) throw new Error("注文詳細の形式を確認できませんでした。");
    setOrder(data.order);
    setPrinterOrderNumber(data.order.productionReadiness?.printerOrderNumber ?? "");
    setNextStatus(recommendedNextStatus(data.order.fulfillmentStatus));
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
        if (active) {
          setOrder(data.order);
          setPrinterOrderNumber(data.order.productionReadiness?.printerOrderNumber ?? "");
          setNextStatus(recommendedNextStatus(data.order.fulfillmentStatus));
        }
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
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextStatus, printerOrderNumber: ["submitted", "shipped"].includes(nextStatus) ? printerOrderNumber.trim() : null, vendorOrderConfirmed }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "権利確認・決済・生成ファイル・製本直送.com側の状態を確認してください。" : "入稿状態を更新できませんでした。");
      await load();
      setVendorOrderConfirmed(false);
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
          <div><dt className="text-xs text-stone-500">入稿状態</dt><dd>{{ not_submitted: "未処理", processing: "処理中", on_hold: "保留", submitted: "入稿済み", shipped: "発送済み" }[order.fulfillmentStatus] ?? order.fulfillmentStatus}</dd></div>
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
        <h2 className="font-semibold">決済後の製本データ生成</h2>
        <p className="mt-3" role="status">
          {order.pdfRenderJob?.state === "queued" ? "生成待ち" :
            order.pdfRenderJob?.state === "rendering" ? "生成中" :
              order.pdfRenderJob?.state === "succeeded" ? "生成完了" :
                order.pdfRenderJob?.state === "failed" ? `生成に失敗しました（${order.pdfRenderJob.errorCode ?? "原因コード未取得"}）` :
                  order.pdfRenderJob?.state === "not_queued" ? "生成ジョブがありません。適用済みの注文は自動で再登録されません。" :
                    order.pdfRenderJob?.state === "not_applicable" ? "決済後に生成します。" :
                      "生成状態を確認できません。キュー機能の設定を確認してください。"}
        </p>
        {order.pdfRenderJob?.attemptCount !== undefined &&
          <p className="mt-1 text-sm text-stone-600">試行回数：{order.pdfRenderJob.attemptCount}</p>}
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">決済通知メール</h2>
        <p className="mt-3" role="status">
          {order.paidNotification?.state === "queued" ? "送信待ち" :
            order.paidNotification?.state === "sending" ? "送信中" :
              order.paidNotification?.state === "sent" ? "送信済み" :
                order.paidNotification?.state === "needs_review" ? `要確認（${order.paidNotification.errorCode ?? "原因コード未取得"}）` :
                  order.paidNotification?.state === "suppressed" ? "通知機能が無効だった期間の注文のため、送信対象外です" :
                    order.paidNotification?.state === "not_created" ? "通知記録なし（既存注文など）" :
                      "通知状態を確認できません。通知キューの設定を確認してください。"}
        </p>
        {order.paidNotification?.attemptCount !== undefined &&
          <p className="mt-1 text-sm text-stone-600">送信試行回数：{order.paidNotification.attemptCount}回（上限8回）</p>}
        {order.paidNotification?.nextAttemptAt && <p className="mt-1 text-sm text-stone-600">次回確認予定：{new Date(order.paidNotification.nextAttemptAt).toLocaleString("ja-JP")}</p>}
        {order.paidNotification?.sentAt && <p className="mt-1 text-sm text-stone-600">送信日時：{new Date(order.paidNotification.sentAt).toLocaleString("ja-JP")}</p>}
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">製本ファイル</h2>
        {order.canDownloadAssets ? <div className="mt-3 flex flex-wrap gap-4">
          <a className="underline" href={`/api/admin/orders/${encodeURIComponent(order.id)}/files/body_pdf`}>本文PDFをダウンロード</a>
          <a className="underline" href={`/api/admin/orders/${encodeURIComponent(order.id)}/files/cover_png`}>表紙PNGをダウンロード</a>
        </div> : <p className="mt-3 text-sm text-stone-600">決済済みかつファイル検証済みの注文のみダウンロードできます。</p>}
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">入稿前の確認</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          <li>決済：{order.paymentStatus === "paid" ? "確認済み" : "未確認"}</li>
          <li>生成済みPDF・表紙PNG：{order.productionReadiness?.assetsReady ? "検証済み" : "未準備"}</li>
          <li>作品の商用利用権：{order.productionReadiness?.rightsApproved ? "全作品確認済み" : "未確認・入稿不可"}</li>
          <li>本文最終ページ数：{order.productionReadiness?.pageCount ?? order.pageCount ?? "未確定"}ページ</li>
          <li>推定背幅：{order.productionReadiness?.spineWidthMm ?? calculateSpineWidthMm(order.productionReadiness?.pageCount ?? order.pageCount ?? 0) ?? "未確定"}mm</li>
        </ul>
        <p className="mt-3 text-sm text-stone-600">製本直送.comで注文確定を確認するまでは「入稿済み」にできません。ここでは外部発注を実行しません。</p>
      </section>
      <section className="rounded border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">製本直送.comへの手動入稿</h2>
        {order.fulfillmentStatus === "shipped" && <p className="mt-3">発送済み</p>}
        {order.fulfillmentStatus === "submitted" && <p className="mt-3">入稿済み：{order.productionReadiness?.printerOrderNumber ?? "注文番号未登録"}</p>}
        {order.fulfillmentStatus !== "shipped" && <div className="mt-4 grid max-w-xl gap-3">
          <label className="grid gap-1 text-sm">次の状態
            <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)} className="rounded border border-stone-300 px-3 py-2">
              {(order.fulfillmentStatus === "not_submitted" ? ["processing", "on_hold", "submitted"] : order.fulfillmentStatus === "processing" ? ["on_hold", "submitted"] : order.fulfillmentStatus === "on_hold" ? ["processing", "submitted"] : ["shipped"]).map((status) => <option key={status} value={status}>{({ processing: "処理中", on_hold: "保留", submitted: "入稿済み", shipped: "発送済み" } as Record<string, string>)[status]}</option>)}
            </select>
          </label>
          {["submitted", "shipped"].includes(nextStatus) && <label className="grid gap-1 text-sm">製本直送.comの注文番号
            <input value={printerOrderNumber} onChange={(event) => setPrinterOrderNumber(event.target.value)} maxLength={100} autoComplete="off" className="rounded border border-stone-300 px-3 py-2" />
          </label>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={vendorOrderConfirmed} onChange={(event) => setVendorOrderConfirmed(event.target.checked)} className="mt-1" />
            {nextStatus === "shipped" ? "製本直送.com側で発送済みであることを確認しました" : nextStatus === "submitted" ? "製本直送.com側で注文確定したことを確認しました" : "状態変更を確認しました"}
          </label>
          <button type="button" className="w-fit rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50" disabled={(nextStatus !== "on_hold" && (!order.canDownloadAssets || !order.productionReadiness?.rightsApproved)) || busy || (["submitted", "shipped"].includes(nextStatus) && (!vendorOrderConfirmed || !printerOrderNumber.trim()))} onClick={markSubmitted}>{busy ? "更新中…" : "状態を記録"}</button>
        </div>}
        {!order.productionReadiness?.rightsApproved && <p className="mt-2 text-sm text-amber-800">権利台帳のA判定がないため、処理開始・入稿・ダウンロードはできません。決済済みの問題注文は保留として記録できます。</p>}
        {order.fulfillmentAudit && order.fulfillmentAudit.length > 0 && <div className="mt-5"><h3 className="font-medium">操作履歴</h3><ol className="mt-2 space-y-2 text-sm">{order.fulfillmentAudit.map((event, index) => <li key={index}>{new Date(event.createdAt).toLocaleString("ja-JP")}：{event.from} → {event.to}{event.printerOrderNumber ? "（" + event.printerOrderNumber + "）" : ""}</li>)}</ol></div>}
      </section>
    </div>
  );
}
