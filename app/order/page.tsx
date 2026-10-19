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
const ORDER_IDEMPOTENCY_SESSION_KEY = "amuhon-order-idempotency-key";

const emptyCustomer: OrderCustomer = {
  name: "",
  postalCode: "",
  prefecture: "",
  city: "",
  address: "",
  phone: "",
  email: "",
};

type SavedDraft = { id: string; status: "draft" | "preparing"; createdAt: string; uploadToken: string };

export default function OrderPage() {
  const [book, setBook] = useState<BookData | null>(null);
  const [customer, setCustomer] = useState<OrderCustomer>(emptyCustomer);
  const [fieldErrors, setFieldErrors] = useState<OrderFieldErrors>({});
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<SavedDraft | null>(null);
  const [bodyPdfFile, setBodyPdfFile] = useState<File | null>(null);
  const [coverPngFile, setCoverPngFile] = useState<File | null>(null);
  const [filesSaved, setFilesSaved] = useState(false);
  const [declaredPageCount, setDeclaredPageCount] = useState<number | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const actionInProgressRef = useRef(false);

  useEffect(() => {
    const currentBook = loadBookData();
    // Browser storage is read after mount; delivery information is never persisted there.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBook(currentBook);
    try {
      const savedIdempotencyKey = sessionStorage.getItem(ORDER_IDEMPOTENCY_SESSION_KEY);
      if (savedIdempotencyKey && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedIdempotencyKey)) {
        idempotencyKeyRef.current = savedIdempotencyKey;
      }
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

  async function uploadOrderFiles(target: SavedDraft) {
    if (!bodyPdfFile || !coverPngFile) {
      setError("本文PDFとカバーPNGの両方を選択してください。");
      return;
    }
    const form = new FormData();
    form.append("bodyPdf", bodyPdfFile);
    form.append("coverPng", coverPngFile);
    const response = await fetch(`/api/orders/${encodeURIComponent(target.id)}/files`, {
      method: "POST",
      headers: { "x-order-upload-token": target.uploadToken },
      body: form,
    });
    const result = await response.json() as { error?: string; order?: { status: string; bodyPdfPageCount: number } };
    if (!response.ok || !result.order || result.order.status !== "preparing") {
      throw new Error(result.error ?? "入稿ファイルを保存できませんでした。同じファイルで再試行してください。");
    }
    setFilesSaved(true);
    setError("");
    try {
      sessionStorage.removeItem(ORDER_IDEMPOTENCY_SESSION_KEY);
    } catch {
      // Session storage is optional; no address or contact data is stored there.
    }
  }

  async function submitDraft() {
    if (!book || actionInProgressRef.current) return;
    if (!bodyPdfFile || !coverPngFile) {
      setError("本文PDFとカバーPNGを選択してから送信してください。");
      return;
    }
    actionInProgressRef.current = true;
    setSaving(true);
    setError("");

    try {
      let targetDraft = draft;
      if (!targetDraft) {
        idempotencyKeyRef.current ??= crypto.randomUUID();
        try {
          sessionStorage.setItem(ORDER_IDEMPOTENCY_SESSION_KEY, idempotencyKeyRef.current);
        } catch {
          // The in-memory key still protects retries until this page is closed.
        }
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
        if (!response.ok || !result.order || !result.order.uploadToken) {
          if (result.fields) setFieldErrors(result.fields);
          throw new Error(result.error ?? "注文下書きを作成できませんでした。");
        }
        targetDraft = result.order;
        setDraft(targetDraft);
      }
      await uploadOrderFiles(targetDraft);
    } catch (submitError) {
      setError(submitError instanceof Error
        ? submitError.message
        : "注文または入稿ファイルを保存できませんでした。表示された内容を確認し、同じ画面から再試行してください。");
    } finally {
      actionInProgressRef.current = false;
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
        <h1 className="text-3xl font-bold">{filesSaved ? "注文下書きと入稿ファイルを保存しました" : "注文下書きを作成しました"}</h1>
        <p className="mt-5">注文ID：<span className="font-mono">{draft.id}</span></p>
        <p className="mt-3 rounded-lg bg-amber-50 p-4">状態：{filesSaved ? "preparing（ファイル検証済み）" : "ファイル未検証"}。価格は未確定のため、決済には進めません。</p>
        <p className="mt-3">価格：価格確認中</p>
        {!filesSaved && (
          <section className="mt-6 rounded-xl border border-stone-200 p-5">
            <h2 className="text-lg font-bold">入稿ファイルを送信</h2>
            <p className="mt-2 text-sm text-stone-600">PDFの実ページ数・A6寸法と、PNGの実寸・350dpiメタデータをサーバーで確認します。ファイル名とブラウザー申告のMIMEタイプは判定に使用しません。</p>
            <label className="mt-4 block font-medium">本文PDF（表紙なし）
              <input className="mt-1 block w-full" type="file" accept="application/pdf,.pdf" onChange={(event) => setBodyPdfFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            <label className="mt-4 block font-medium">見開きカバーPNG
              <input className="mt-1 block w-full" type="file" accept="image/png,.png" onChange={(event) => setCoverPngFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
            <button className="mt-5 rounded-lg bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => void submitDraft()} disabled={saving || !bodyPdfFile || !coverPngFile}>
              {saving ? "検証・アップロード中……" : "2ファイルを検証して保存"}
            </button>
          </section>
        )}
        {filesSaved && <p className="mt-3 text-sm text-stone-600">配送先情報と非公開の入稿ファイルはサーバー側の注文IDに紐付けて保存されました。決済機能は未実装です。</p>}
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
          <section className="mt-5 rounded-xl border border-stone-200 p-5" aria-label="入稿ファイル選択">
            <h3 className="font-bold">先に出力した入稿ファイルを選択してください</h3>
            <p className="mt-2 text-sm text-stone-600">/final で本文PDF（表紙なし）を保存し、見開きカバー作成画面でPNGを保存してから、この画面に戻って選択してください。各ファイル60MiB以下、2ファイル合計約120MiB以下です。</p>
            <label className="mt-4 block font-medium">本文PDF（表紙なし）
              <input className="mt-1 block w-full" type="file" accept="application/pdf,.pdf" onChange={(event) => setBodyPdfFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            <label className="mt-4 block font-medium">見開きカバーPNG
              <input className="mt-1 block w-full" type="file" accept="image/png,.png" onChange={(event) => setCoverPngFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            {bodyPdfFile && <p className="mt-2 text-sm">本文PDF選択済み（{Math.ceil(bodyPdfFile.size / 1024 / 1024)}MiB）</p>}
            {coverPngFile && <p className="mt-1 text-sm">カバーPNG選択済み（{Math.ceil(coverPngFile.size / 1024 / 1024)}MiB）</p>}
          </section>
          {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-lg border border-stone-400 px-5 py-3" type="button" onClick={() => { setError(""); setStep("form"); }} disabled={saving}>戻って修正する</button>
            <button className="rounded-lg bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => void submitDraft()} disabled={saving || !bodyPdfFile || !coverPngFile}>
              {saving ? "下書き作成・検証・アップロード中……" : "下書きを作成してファイルを送信する"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
