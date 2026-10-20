"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Upload } from "tus-js-client";

import { bookLayoutKey, loadBookData, type BookData } from "@/lib/book";
import { createOrderTusHeaders, inspectOrderTusCredentials } from "@/lib/order-tus";
import {
  JAPANESE_PREFECTURES,
  validateOrderCustomer,
  type OrderCustomer,
  type OrderFieldErrors,
} from "@/lib/order";

const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";
const ORDER_IDEMPOTENCY_SESSION_KEY = "amuhon-order-idempotency-key";
const DIRECT_UPLOAD_SESSION_KEY = "amuhon-order-direct-upload";
const DIRECT_UPLOAD_EXPERIMENT = process.env.NEXT_PUBLIC_ORDER_DIRECT_UPLOAD_EXPERIMENT === "true";
const TUS_AUTH_DIAGNOSTICS = process.env.NODE_ENV === "development" && DIRECT_UPLOAD_EXPERIMENT &&
  process.env.NEXT_PUBLIC_ORDER_UPLOAD_DIAGNOSTICS === "true";
const MAX_ORDER_ASSET_BYTES = 40_000_000;

const emptyCustomer: OrderCustomer = {
  name: "",
  postalCode: "",
  prefecture: "",
  city: "",
  address: "",
  phone: "",
  email: "",
};

type SavedDraft = { id: string; status: "draft" | "preparing"; createdAt: string };
type DirectUploadIntent = {
  attemptId: string;
  expiresAt: string;
  bucket: string;
  tusEndpoint: string;
  bodyObjectKey: string;
  coverObjectKey: string;
  bodyUploadSignature: string;
  coverUploadSignature: string;
  uploadMaxBytes: number;
  verified: false;
  diagnostics?: { signerAndTusProjectMatch: boolean };
};
type TusDiagnostic = {
  asset: "本文PDF" | "カバーPNG";
  signatureMatches: boolean;
  signaturePresent: boolean;
  signatureHasThreeParts: boolean;
  apiKeyMatches: boolean;
  signerAndTusProjectMatch: boolean | null;
};

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
  const [uploadProgress, setUploadProgress] = useState<{ bodyPdf: number; coverPng: number } | null>(null);
  const [directUploadExpiresAt, setDirectUploadExpiresAt] = useState<string | null>(null);
  const [tusDiagnostics, setTusDiagnostics] = useState<TusDiagnostic[]>([]);
  const [declaredPageCount, setDeclaredPageCount] = useState<number | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const actionInProgressRef = useRef(false);
  const directAttemptIdRef = useRef<string | null>(null);

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
      if (DIRECT_UPLOAD_EXPERIMENT) {
        const directState = sessionStorage.getItem(DIRECT_UPLOAD_SESSION_KEY);
        if (directState) {
          const parsed = JSON.parse(directState) as { id?: unknown; status?: unknown; createdAt?: unknown; attemptId?: unknown; uploaded?: unknown };
          if (typeof parsed.id === "string" && /^[0-9a-f-]{36}$/i.test(parsed.id) &&
              (parsed.status === "draft" || parsed.status === "preparing") && typeof parsed.createdAt === "string" &&
              typeof parsed.attemptId === "string" && /^[0-9a-f-]{36}$/i.test(parsed.attemptId)) {
            directAttemptIdRef.current = parsed.attemptId;
            setDraft({ id: parsed.id, status: parsed.status, createdAt: parsed.createdAt });
            if (parsed.uploaded === true) setFilesSaved(true);
          }
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
    if (DIRECT_UPLOAD_EXPERIMENT) {
      await uploadOrderFilesDirect(target);
      return;
    }
    const form = new FormData();
    form.append("bodyPdf", bodyPdfFile);
    form.append("coverPng", coverPngFile);
    const response = await fetch(`/api/orders/${encodeURIComponent(target.id)}/files`, {
      method: "POST",
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

  function persistDirectUploadState(target: SavedDraft, attemptId: string, uploaded: boolean) {
    try {
      sessionStorage.setItem(DIRECT_UPLOAD_SESSION_KEY, JSON.stringify({
        id: target.id,
        status: target.status,
        createdAt: target.createdAt,
        attemptId,
        uploaded,
      }));
    } catch {
      // The cookie and in-memory state remain authoritative for this open page.
    }
  }

  async function uploadTusFile(
    file: File,
    intent: DirectUploadIntent,
    objectKey: string,
    signature: string,
    contentType: "application/pdf" | "image/png",
    asset: TusDiagnostic["asset"],
    onProgress: (percent: number) => void,
  ) {
    const publicApiKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!publicApiKey) throw new Error("TUSアップロード用の公開Supabaseキーが設定されていません。");
    if (file.size > MAX_ORDER_ASSET_BYTES) throw new Error("PDF・PNGはそれぞれ40,000,000バイト（40MB）以下にしてください。");

    const upload = new Upload(file, {
      endpoint: intent.tusEndpoint,
      headers: createOrderTusHeaders(publicApiKey, signature),
      metadata: {
        bucketName: intent.bucket,
        objectName: objectKey,
        contentType,
        cacheControl: "3600",
      },
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      storeFingerprintForResuming: true,
      // Keep the resumable location after a successful first file so a retry
      // after the second file failed can safely resume the same unique key.
      removeFingerprintOnSuccess: false,
      fingerprint: async (candidate) => [
        "amuhon", intent.attemptId, objectKey, candidate.name, candidate.size, candidate.lastModified,
      ].join(":"),
      ...(TUS_AUTH_DIAGNOSTICS ? {
        onBeforeRequest: (request) => {
          if (request.getMethod() !== "POST" || !request.getURL().startsWith(intent.tusEndpoint)) return;
          const result = inspectOrderTusCredentials(
            signature,
            request.getHeader("x-signature"),
            publicApiKey,
            request.getHeader("apikey"),
          );
          setTusDiagnostics((current) => [
            ...current.filter((item) => item.asset !== asset),
            {
              asset,
              ...result,
              signerAndTusProjectMatch: intent.diagnostics?.signerAndTusProjectMatch ?? null,
            },
          ]);
        },
      } : {}),
      onProgress: (sent, total) => onProgress(total ? Math.min(100, Math.floor((sent / total) * 100)) : 0),
    });
    const previousUploads = await upload.findPreviousUploads();
    if (previousUploads.length > 0) upload.resumeFromPreviousUpload(previousUploads[0]);
    await new Promise<void>((resolve, reject) => {
      upload.options.onError = reject;
      upload.options.onSuccess = () => resolve();
      upload.start();
    });
  }

  async function uploadOrderFilesDirect(target: SavedDraft) {
    if (!bodyPdfFile || !coverPngFile) {
      setError("本文PDFとカバーPNGの両方を選択してください。");
      return;
    }
    const attemptId = directAttemptIdRef.current ?? crypto.randomUUID();
    directAttemptIdRef.current = attemptId;
    if (TUS_AUTH_DIAGNOSTICS) setTusDiagnostics([]);
    persistDirectUploadState(target, attemptId, false);
    setUploadProgress({ bodyPdf: 0, coverPng: 0 });

    const response = await fetch(`/api/orders/${encodeURIComponent(target.id)}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId }),
      credentials: "same-origin",
    });
    const result = await response.json() as { error?: string } & Partial<DirectUploadIntent>;
    if (!response.ok || typeof result.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.attemptId) || !result.tusEndpoint || !result.bucket ||
        !result.bodyObjectKey || !result.coverObjectKey || !result.bodyUploadSignature || !result.coverUploadSignature ||
        result.uploadMaxBytes !== MAX_ORDER_ASSET_BYTES || result.verified !== false) {
      throw new Error(result.error ?? "一時アップロード権限を取得できませんでした。");
    }
    const intent = result as DirectUploadIntent;
    directAttemptIdRef.current = intent.attemptId;
    persistDirectUploadState(target, intent.attemptId, false);
    setDirectUploadExpiresAt(intent.expiresAt);
    await uploadTusFile(bodyPdfFile, intent, intent.bodyObjectKey, intent.bodyUploadSignature, "application/pdf", "本文PDF", (percent) => {
      setUploadProgress((current) => ({ bodyPdf: percent, coverPng: current?.coverPng ?? 0 }));
    });
    await uploadTusFile(coverPngFile, intent, intent.coverObjectKey, intent.coverUploadSignature, "image/png", "カバーPNG", (percent) => {
      setUploadProgress((current) => ({ bodyPdf: current?.bodyPdf ?? 100, coverPng: percent }));
    });
    setFilesSaved(true);
    setError("");
    persistDirectUploadState(target, intent.attemptId, true);
    try {
      sessionStorage.removeItem(ORDER_IDEMPOTENCY_SESSION_KEY);
    } catch {
      // Session storage is optional; no customer information is stored there.
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
        if (!response.ok || !result.order) {
          if (result.fields) setFieldErrors(result.fields);
          throw new Error(result.error ?? "注文下書きを作成できませんでした。");
        }
        targetDraft = result.order;
        setDraft(targetDraft);
        if (DIRECT_UPLOAD_EXPERIMENT) {
          directAttemptIdRef.current ??= crypto.randomUUID();
          persistDirectUploadState(targetDraft, directAttemptIdRef.current, false);
        }
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
        <h1 className="text-3xl font-bold">{filesSaved
          ? DIRECT_UPLOAD_EXPERIMENT ? "注文下書きと一時アップロードを完了しました" : "注文下書きと入稿ファイルを保存しました"
          : "注文下書きを作成しました"}</h1>
        <p className="mt-5">注文ID：<span className="font-mono">{draft.id}</span></p>
        <p className="mt-3 rounded-lg bg-amber-50 p-4">状態：{filesSaved
          ? DIRECT_UPLOAD_EXPERIMENT ? "preparing（一時保存済み・未検証）" : "preparing（ファイル検証済み）"
          : "ファイル未検証"}。価格は未確定のため、決済には進めません。</p>
        <p className="mt-3">価格：価格確認中</p>
        {!filesSaved && (
          <section className="mt-6 rounded-xl border border-stone-200 p-5">
            <h2 className="text-lg font-bold">入稿ファイルを送信</h2>
            <p className="mt-2 text-sm text-stone-600">{DIRECT_UPLOAD_EXPERIMENT
              ? "実験モード：TUSで一時領域へ送信します。現在はアップロードのみで、実ファイル検証・確定保存はまだ行いません。再試行時は同じファイルを選び直してください。"
              : "PDFの実ページ数・A6寸法と、PNGの実寸・350dpiメタデータをサーバーで確認します。ファイル名とブラウザー申告のMIMEタイプは判定に使用しません。"}</p>
            <label className="mt-4 block font-medium">本文PDF（表紙なし）
              <input className="mt-1 block w-full" type="file" accept="application/pdf,.pdf" onChange={(event) => setBodyPdfFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            <label className="mt-4 block font-medium">見開きカバーPNG
              <input className="mt-1 block w-full" type="file" accept="image/png,.png" onChange={(event) => setCoverPngFile(event.target.files?.[0] ?? null)} disabled={saving} />
            </label>
            {DIRECT_UPLOAD_EXPERIMENT && uploadProgress && (
              <div className="mt-4 space-y-2 text-sm" aria-live="polite">
                <p>本文PDF：{uploadProgress.bodyPdf}%</p>
                <progress className="w-full" max={100} value={uploadProgress.bodyPdf} />
                <p>カバーPNG：{uploadProgress.coverPng}%</p>
                <progress className="w-full" max={100} value={uploadProgress.coverPng} />
                <p>各ファイル40,000,000バイト（40MB）以下。一時ファイルの期限：{directUploadExpiresAt ? new Date(directUploadExpiresAt).toLocaleString("ja-JP") : "取得中"}</p>
              </div>
            )}
            {TUS_AUTH_DIAGNOSTICS && (
              <section className="mt-4 rounded-lg border border-sky-300 bg-sky-50 p-4 text-sm" aria-label="TUS認証の一時診断">
                <h3 className="font-bold">開発用TUS認証診断</h3>
                <p className="mt-1">値やトークンは表示せず、TUS開始POSTのヘッダー比較結果だけを表示します。</p>
                {(["本文PDF", "カバーPNG"] as const).map((asset) => {
                  const diagnostic = tusDiagnostics.find((item) => item.asset === asset);
                  const state = (value: boolean | null | undefined) => value === null || value === undefined ? "未確認" : value ? "一致／はい" : "不一致／いいえ";
                  return (
                    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1" key={asset}>
                      <dt className="col-span-2 mt-1 font-semibold">{asset}</dt>
                      <dt>API署名とx-signature</dt><dd>{state(diagnostic?.signatureMatches)}</dd>
                      <dt>x-signatureが空でない</dt><dd>{state(diagnostic?.signaturePresent)}</dd>
                      <dt>x-signatureが3区分形式</dt><dd>{state(diagnostic?.signatureHasThreeParts)}</dd>
                      <dt>公開キーとapikey</dt><dd>{state(diagnostic?.apiKeyMatches)}</dd>
                      <dt>署名発行先とTUS先が同一プロジェクト</dt><dd>{state(diagnostic?.signerAndTusProjectMatch)}</dd>
                    </dl>
                  );
                })}
              </section>
            )}
            {error && <p role="alert" className="mt-4 text-red-700">{error}</p>}
            <button className="mt-5 rounded-lg bg-stone-900 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => void submitDraft()} disabled={saving || !bodyPdfFile || !coverPngFile}>
              {saving ? DIRECT_UPLOAD_EXPERIMENT ? "TUSで一時アップロード中……" : "検証・アップロード中……"
                : DIRECT_UPLOAD_EXPERIMENT ? "2ファイルをTUSで一時保存" : "2ファイルを検証して保存"}
            </button>
          </section>
        )}
        {filesSaved && <p className="mt-3 text-sm text-stone-600">{DIRECT_UPLOAD_EXPERIMENT
          ? "非公開の一時領域への送信は完了しました。本文検証・本番保存・決済可能化は行っていません。"
          : "配送先情報と非公開の入稿ファイルはサーバー側の注文IDに紐付けて保存されました。決済機能は未実装です。"}</p>}
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
            <h3 className="font-bold">{DIRECT_UPLOAD_EXPERIMENT ? "実験用：アップロードするファイルを選択" : "先に出力した入稿ファイルを選択してください"}</h3>
            {DIRECT_UPLOAD_EXPERIMENT ? (
              <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                直接アップロード実験モードが有効です。送信時に注文下書きを作成し、TUSで非公開の一時領域へアップロードします。この実験ではファイル検証・確定保存は行わず、決済可能にもなりません。/final の本文PDFと見開きカバーPNGを選択してください。各ファイル40,000,000バイト（40MB）以下です。
              </p>
            ) : (
              <p className="mt-2 text-sm text-stone-600">/final で本文PDF（表紙なし）を保存し、見開きカバー作成画面でPNGを保存してから、この画面に戻って選択してください。各ファイル40,000,000バイト（40MB）以下、2ファイル合計約80MB以下です。</p>
            )}
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
              {saving
                ? DIRECT_UPLOAD_EXPERIMENT ? "下書き作成・TUS一時アップロード中……" : "下書き作成・検証・アップロード中……"
                : DIRECT_UPLOAD_EXPERIMENT ? "下書きを作成してTUSで一時アップロードする" : "下書きを作成してファイルを送信する"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
