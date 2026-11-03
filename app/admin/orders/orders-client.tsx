"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type AdminOrderListItem = {
  id: string;
  orderNumber: string;
  title: string;
  pageCount: number | null;
  amountYen: number | null;
  currency: string | null;
  paymentStatus: string;
  fulfillmentStatus: string;
  createdAt: string;
};

function paymentLabel(status: string) {
  return status === "paid" ? "決済済み" : status === "ready_for_payment" ? "決済待ち" : status;
}

function fulfillmentLabel(status: string) {
  return status === "submitted" ? "入稿済み" : "未入稿";
}

export function AdminOrdersClient() {
  const [orders, setOrders] = useState<AdminOrderListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/orders", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "ログイン状態を確認してください。" : response.status === 403 ? "管理者として許可されていません。" : "注文一覧を読み込めませんでした。");
        return response.json() as Promise<{ orders?: unknown }>;
      })
      .then((result) => {
        if (!Array.isArray(result.orders)) throw new Error("注文一覧の形式を確認できませんでした。");
        if (active) setOrders(result.orders as AdminOrderListItem[]);
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "注文一覧を読み込めませんでした。"); });
    return () => { active = false; };
  }, []);

  if (error) return <p role="alert" className="mt-6 rounded bg-red-50 p-4 text-red-800">{error}</p>;
  if (!orders) return <p className="mt-6 text-stone-600">注文を読み込み中…</p>;
  if (orders.length === 0) return <p className="mt-6 text-stone-600">注文はありません。</p>;

  return (
    <div className="mt-6 overflow-x-auto rounded border border-stone-200 bg-white">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-stone-100"><tr><th className="p-3">注文番号</th><th className="p-3">書名</th><th className="p-3">ページ</th><th className="p-3">価格</th><th className="p-3">決済</th><th className="p-3">製本入稿</th><th className="p-3">受付日時</th></tr></thead>
        <tbody>{orders.map((order) => <tr className="border-t border-stone-200" key={order.id}>
          <td className="p-3"><Link className="underline" href={`/admin/orders/${encodeURIComponent(order.id)}`}>{order.orderNumber}</Link></td>
          <td className="p-3">{order.title}</td><td className="p-3">{order.pageCount ?? "未確定"}</td>
          <td className="p-3">{Number.isSafeInteger(order.amountYen) ? `${new Intl.NumberFormat("ja-JP").format(order.amountYen as number)}円` : "未確定"}</td>
          <td className="p-3">{paymentLabel(order.paymentStatus)}</td><td className="p-3">{fulfillmentLabel(order.fulfillmentStatus)}</td>
          <td className="p-3">{new Date(order.createdAt).toLocaleString("ja-JP")}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}
