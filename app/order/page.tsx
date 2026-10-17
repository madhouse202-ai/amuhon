"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { bookLayoutKey, loadBookData, type BookData } from "@/lib/book";
import {
  JAPANESE_PREFECTURES,
  validateOrderCustomer,
  type OrderCustomer,
  type OrderFieldErrors,
} from "@/lib/order";

const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";

const emptyCustomer: OrderCustomer = {
  name: "",
  postalCode: "",
  prefecture: "",
  city: "",
  address: "",
  phone: "",
  email: "",
};

type SavedDraft = { id: string; status: "draft"; createdAt: string };

export default function OrderPage() {
  const [book, setBook] = useState<BookData | null>(null);
  const [customer, setCustomer] = useState<OrderCustomer>(emptyCustomer);
  const [fieldErrors, setFieldErrors] = useState<OrderFieldErrors>({});
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<SavedDraft | null>(null);
  const [declaredPageCount, setDeclaredPageCount] = useState<number | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const currentBook = loadBookData();
    // Browser storage is read after mount; delivery information is never persisted there.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBook(currentBook);
    try {
      const saved = sessionStorage.getItem(COVER_PAGE_COUNT_SESSION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { bodyPdfPageCount?: unknown; pageCount?: unknown; worksKey?: unknown };
        const pageCount = parsed.bodyPdfPageCount ?? parsed.pageCount;
        if (parsed.worksKey === bookLayoutKey(currentBook) && Number.isInteger(pageCount) && Number(pageCount) > 0) {
          setDeclaredPageCount(Number(pageCount));
        }
      }
    } catch {
      setDeclaredPageCount(null);
    }
  }, []);

  function updateCustomer(field: keyof OrderCustomer, value: string) {
    setCustomer((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  function continueToConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const result = validateOrderCustomer(customer);
    setFieldErrors(result.errors);
    if (!result.customer) return;
    setCustomer(result.customer);
    setStep("confirm");
  }

  async function submitDraft() {
    if (!book || saving || draft) return;
    setSaving(true);
    setError("");
    idempotencyKeyRef.current ??= crypto.randomUUID();

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyRef.current,
          customer,
          book: {
            title: book.title,
            editor: book.editor,
            coverStyle: book.coverStyle,
            coverColor: book.coverColor,
            works: book.works,
          },
          declaredBodyPdfPageCount: declaredPageCount,
        }),
      });
      const result = await response.json() as {
        error?: string;
        order?: SavedDraft;
        fields?: OrderFieldErrors;
      };
      if (!response.ok || !result.order) {
        if (result.fields) setFieldErrors(result.fields);
        setError(result.error ?? "注文を保存できませんでした。入力内容は保存されていません。");
        return;
      }
      setDraft(result.order);
    } catch {
      setError("注文保存サービスに接続できませんでした。入力内容は保存されていません。同じ画面から再試行できます。");
    } finally {
      setSaving(false);
    }
  }

  if (!book) {
    return <main className="mx-auto max-w-3xl px-6 py-12"><p>本の情報を読み込んでいます……</p></main>;
  }

  if (book.works.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">注文手続き</h1>
        <p className="mt-6">注文する本の作品情報がありません。</p>
        <Link className="mt-4 inline-block underline" href="/create">作品を選ぶ</Link>
      </main>
    );
  }

  if (draft) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12 text-stone-800">
        <h1 className="text-3xl font-bold">注文情報を仮保存しました</h1>
        <p className="mt-5">注文ID：<span className="font-mono">{draft.id}</span></p>
        <p className="mt-3 rounded-lg bg-amber-50 p-4">ステータス：下書き。本文PDF・カバーPNGはサーバー側で検証・保存されていないため、決済には進めません。</p>
        <p className="mt-3">価格：価格確認中</p>
        <p className="mt-3 text-sm text-stone-600">配送先情報は注文管理者だけが参照できるサーバー側データとして保存されました。</p>
      </main>
    );
  }

  const field = (
    key: keyof OrderCustomer,
    label: string,
    type = "text",
    props: Record<string, string> = {},
  ) => (
    <label className="block">
      <span className="mb-1 block font-medium">{label}<span className="ml-1 text-red-700">*</span></span>
      <input
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2"
        type={type}
        required
        maxLength={key === "address" ? 200 : key === "email" ? 254 : 100}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode as "text" | "numeric" | "tel" | "email" | undefined}
        value={customer[key]}
        onChange={(event) => updateCustomer(key, event.target.value)}
        aria-invalid={Boolean(fieldErrors[key])}
        aria-describedby={fieldErrors[key] ? `${key}-error` : undefined}
      />
      {fieldErrors[key] && <span className="mt-1 block text-sm text-red-700" id={`${key}-error`}>{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-stone-800">
      <Link href="/book-preview" className="text-sm underline">本のプレビューへ戻る</Link>
      <h1 className="mt-5 text-3xl font-bold">注文手続き</h1>
      <p className="mt-2 text-stone-600">会員登録は不要です。価格は確定していないため「価格確認中」と表示しています。</p>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5" aria-label="注文する本">
        <h2 className="text-xl font-bold">{book.title}</h2>
        <p className="mt-1">編者：{book.editor}</p>
        <p className="mt-1">収録作品：{book.works.length}作品</p>
        <ul className="mt-3 list-inside list-disc text-sm text-stone-700">
          {book.works.map((work, index) => <li key={`${work.id}-${index}`}>{index + 1}. {work.title} — {work.author || "作者情報なし"}</li>)}
        </ul>
        <p className="mt-3 font-semibold">価格：価格確認中</p>
        <p className="mt-2 text-sm text-stone-600">
          {declaredPageCount
            ? `本文PDFページ数（ブラウザー組版の申告値）：${declaredPageCount}ページ。サーバー検証前のため未確定です。`
            : "本文PDFの最終ページ数は未確定です。/final で組版すると参考ページ数を引き継げます。"}
        </p>
      </section>

      {step === "form" ? (
        <form className="mt-8 space-y-5" onSubmit={continueToConfirmation} noValidate>
          <h2 className="text-xl font-bold">配送先・連絡先</h2>
          {field("name", "氏名", "text", { autoComplete: "name" })}
          {field("postalCode", "郵便番号", "text", { autoComplete: "postal-code", inputMode: "numeric" })}
          <label className="block">
            <span className="mb-1 block font-medium">都道府県<span className="ml-1 text-red-700">*</span></span>
            <select className="w-full rounded-md border border-stone-300 bg-white px-3 py-2" required value={customer.prefecture} onChange={(event) => updateCustomer("prefecture", event.target.value)} aria-invalid={Boolean(fieldErrors.prefecture)}>
              <option value="">選択してください</option>
              {JAPANESE_PREFECTURES.map((prefecture) => <option key={prefecture} value={prefecture}>{prefecture}</option>)}
            </select>
            {fieldErrors.prefecture && <span className="mt-1 block text-sm text-red-700">{fieldErrors.prefecture}</span>}
          </label>
          {field("city", "市区町村", "text", { autoComplete: "address-level2" })}
          {field("address", "番地・建物名", "text", { autoComplete: "street-address" })}
          {field("phone", "電話番号", "tel", { autoComplete: "tel", inputMode: "tel" })}
          {field("email", "メールアドレス", "email", { autoComplete: "email", inputMode: "email" })}
          <p className="text-sm text-stone-600">入力内容は確認後に送信されます。入力中の配送先情報はブラウザーへ保存しません。</p>
          <button className="rounded-lg bg-stone-900 px-6 py-3 font-bold text-white" type="submit">入力内容を確認する</button>
        </form>
      ) : (
        <section className="mt-8" aria-labelledby="confirm-heading">
          <h2 id="confirm-heading" className="text-xl font-bold">入力内容の確認</h2>
          <dl className="mt-4 grid grid-cols-1 gap-3 rounded-xl bg-stone-50 p-5 sm:grid-cols-2">
            <dt>氏名</dt><dd>{customer.name}</dd>
            <dt>郵便番号</dt><dd>{customer.postalCode}</dd>
            <dt>都道府県</dt><dd>{customer.prefecture}</dd>
            <dt>市区町村</dt><dd>{customer.city}</dd>
            <dt>番地・建物名</dt><dd>{customer.address}</dd>
            <dt>電話番号</dt><dd>{customer.phone}</dd>
            <dt>メールアドレス</dt><dd>{customer.email}</dd>
          </dl>
          <p className="mt-4 rounded-lg bg-amber-50 p-4">価格確認中です。今回は注文下書きの保存のみ行い、決済・製本発注には進みません。</p>
          {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-lg border border-stone-400 px-5 py-3" type="button" onClick={() => { setError(""); setStep("form"); }} disabled={saving}>戻って修正する</button>
            <button className="rounded-lg bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => void submitDraft()} disabled={saving}>
              {saving ? "下書きを保存しています……" : "注文下書きを保存する"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
