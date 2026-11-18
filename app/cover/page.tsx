"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreationProgress } from "@/app/creation-progress";
import { DraftSaveStatus } from "@/app/draft-save-status";
import {
  CoverStyle,
  CoverColor,
  type BookData,
} from "@/lib/book";
import { useBookDraftAutosave } from "@/lib/use-book-draft-autosave";
import { calculateCoverLayout, isSubmissionPageCount } from "@/lib/production";
import { CoverSpreadPreview } from "@/app/cover-spread-preview";

const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";

type CoverPageCount = { bodyPdfPageCount: number; worksKey: string };
const PREVIEW_ONLY_BODY_PAGE_COUNT = 80;

function storedPageCountMatchesWorks(worksKey: string, book: BookData | null): boolean {
  if (!book) return false;
  try {
    const parsed = JSON.parse(worksKey) as { works?: unknown };
    const storedWorks = parsed && Array.isArray(parsed.works) ? parsed.works : null;
    const currentWorks = book.works.map((work) => [work.id, work.title, work.author, work.xhtmlUrl]);
    return storedWorks !== null && JSON.stringify(storedWorks) === JSON.stringify(currentWorks);
  } catch {
    return false;
  }
}

export default function CoverPage() {
  const router = useRouter();
  const { draft, updateDraft, loadState, saveState, flushDraft } = useBookDraftAutosave();

  const bookData: BookData | null = loadState === "ready" ? draft : null;
  const title = draft.title;
  const editor = draft.editor;
  const coverStyle: CoverStyle = draft.coverStyle;
  const coverColor: CoverColor = draft.coverColor;
  const [coverPageCount, setCoverPageCount] = useState<CoverPageCount | null>(null);
  const [coverExporting, setCoverExporting] = useState(false);

  useEffect(() => {
    try {
      const value = sessionStorage.getItem(COVER_PAGE_COUNT_SESSION_KEY);
      const parsedValue = value ? JSON.parse(value) as Partial<CoverPageCount> & { pageCount?: number } : null;
      // Support the previous session shape while migrating to the explicit PDF page-count name.
      const pageCount = parsedValue ? {
        bodyPdfPageCount: parsedValue.bodyPdfPageCount ?? parsedValue.pageCount ?? NaN,
        worksKey: parsedValue.worksKey ?? "",
      } : null;
      // Hydrate the browser-only page-count handoff after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCoverPageCount(pageCount);
    } catch {
      setCoverPageCount(null);
    }
  }, []);

  const currentBook = bookData;
  const pageCountMatchesBook = Boolean(
    coverPageCount && Number.isInteger(coverPageCount.bodyPdfPageCount) && currentBook &&
    storedPageCountMatchesWorks(coverPageCount.worksKey, currentBook),
  );
  const pageCountIsEligible = Boolean(
    pageCountMatchesBook && coverPageCount &&
    isSubmissionPageCount(coverPageCount.bodyPdfPageCount),
  );
  const confirmedBodyPageCount = pageCountIsEligible && coverPageCount
    ? coverPageCount.bodyPdfPageCount
    : null;
  const previewBodyPageCount = confirmedBodyPageCount ?? PREVIEW_ONLY_BODY_PAGE_COUNT;
  const layout = bookData
    ? calculateCoverLayout(previewBodyPageCount)
    : null;
  const spreadReady = loadState === "ready" && layout !== null;
  const rendererInternalMode = process.env.AMUHON_PDF_RENDERER_INTERNAL_MODE === "true";

  async function downloadRendererCover() {
    if (!rendererInternalMode || !spreadReady || confirmedBodyPageCount === null || coverExporting) return;
    setCoverExporting(true);
    try {
      const { createSpreadCoverPngBlob } = await import("@/lib/print-cover-renderer");
      const blob = await createSpreadCoverPngBlob({ title, editor, coverStyle, coverColor }, confirmedBodyPageCount);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cover.png";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      alert("表紙の生成に失敗しました。レンダラーの状態を確認してください。");
    } finally {
      setCoverExporting(false);
    }
  }

  function saveCoverSettings() {
    if (loadState !== "ready") return false;
    const normalizedDraft = {
      ...draft,
      title: title.trim() || "わたしの本",
      editor: editor.trim() || "編者",
      coverStyle,
      coverColor,
    };
    if (!flushDraft(normalizedDraft)) return false;
    updateDraft(normalizedDraft);
    return true;
  }

  function handleSave() {
    if (!saveCoverSettings()) return;

    alert("この表紙で決定しました！");

    router.push("/final");
  }

  function returnToWorkSelection() {
    if (!saveCoverSettings()) return;
    router.push("/create");
  }

  return (
    <main
      style={{
        maxWidth: "900px",
        margin: "0 auto",
        padding: "50px 20px 100px",
      }}
    >
      <CreationProgress
        currentStep={2}
        allowCompletedNavigation={saveState === "idle" || saveState === "saved"}
      />
      <div style={{ marginBottom: "18px" }}>
        <DraftSaveStatus loadState={loadState} saveState={saveState} onRetry={() => flushDraft()} />
      </div>
      <button
        type="button"
        onClick={returnToWorkSelection}
        disabled={!bookData}
        className="mb-5 rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 disabled:opacity-50"
      >
        作品を選び直す
      </button>
      <h1
        style={{
          fontSize: "32px",
          fontWeight: "bold",
          marginBottom: "40px",
        }}
      >
        表紙を作る
      </h1>

      {/* 本のタイトル */}
      <section style={{ marginBottom: "35px" }}>
        <h2
          style={{
            fontSize: "20px",
            fontWeight: "bold",
            marginBottom: "12px",
          }}
        >
          本のタイトル
        </h2>

        <input
          type="text"
          value={title}
          onChange={(e) => updateDraft((current) => ({ ...current, title: e.target.value }))}
          disabled={!bookData}
          placeholder="わたしの本"
          style={{
            width: "100%",
            maxWidth: "500px",
            padding: "12px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "6px",
            boxSizing: "border-box",
          }}
        />
      </section>

      {/* 編者 */}
      <section style={{ marginBottom: "35px" }}>
        <h2
          style={{
            fontSize: "20px",
            fontWeight: "bold",
            marginBottom: "12px",
          }}
        >
          編者
        </h2>

        <input
          type="text"
          value={editor}
          onChange={(e) => updateDraft((current) => ({ ...current, editor: e.target.value }))}
          disabled={!bookData}
          placeholder="編者"
          style={{
            width: "100%",
            maxWidth: "500px",
            padding: "12px",
            fontSize: "16px",
            border: "1px solid #ccc",
            borderRadius: "6px",
            boxSizing: "border-box",
          }}
        />
      </section>

      {/* 表紙スタイル */}
      <section style={{ marginBottom: "35px" }}>
        <h2
          style={{
            fontSize: "20px",
            fontWeight: "bold",
            marginBottom: "12px",
          }}
        >
          表紙スタイル
        </h2>

        <div
          style={{
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => updateDraft((current) => ({ ...current, coverStyle: "classic" }))}
            disabled={!bookData}
            style={{
              padding: "12px 20px",
              borderRadius: "6px",
              border:
                coverStyle === "classic"
                  ? "2px solid #111"
                  : "1px solid #ccc",
              background:
                coverStyle === "classic"
                  ? "#f0f0f0"
                  : "#fff",
              cursor: "pointer",
            }}
          >
            基本デザイン
          </button>

          <button
            type="button"
            onClick={() => updateDraft((current) => ({ ...current, coverStyle: "free" }))}
            disabled={!bookData}
            style={{
              padding: "12px 20px",
              borderRadius: "6px",
              border:
                coverStyle === "free"
                  ? "2px solid #111"
                  : "1px solid #ccc",
              background:
                coverStyle === "free"
                  ? "#f0f0f0"
                  : "#fff",
              cursor: "pointer",
            }}
          >
            自由デザイン
          </button>
        </div>
      </section>

      {/* 表紙カラー */}
      <section style={{ marginBottom: "45px" }}>
        <h2
          style={{
            fontSize: "20px",
            fontWeight: "bold",
            marginBottom: "12px",
          }}
        >
          表紙カラー
        </h2>

        <div
          style={{
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => updateDraft((current) => ({ ...current, coverColor: "red" }))}
            disabled={!bookData}
            style={{
              padding: "12px 20px",
              borderRadius: "6px",
              border:
                coverColor === "red"
                  ? "2px solid #111"
                  : "1px solid #ccc",
              background: "#d9534f",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            赤
          </button>

          <button
            type="button"
            onClick={() => updateDraft((current) => ({ ...current, coverColor: "blue" }))}
            disabled={!bookData}
            style={{
              padding: "12px 20px",
              borderRadius: "6px",
              border:
                coverColor === "blue"
                  ? "2px solid #111"
                  : "1px solid #ccc",
              background: "#4285c5",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            青
          </button>

          <button
            type="button"
            onClick={() => updateDraft((current) => ({ ...current, coverColor: "green" }))}
            disabled={!bookData}
            style={{
              padding: "12px 20px",
              borderRadius: "6px",
              border:
                coverColor === "green"
                  ? "2px solid #111"
                  : "1px solid #ccc",
              background: "#4f8a5b",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            緑
          </button>
        </div>
      </section>

      <section className="mb-10 rounded-2xl bg-stone-100 p-5 sm:p-8" aria-labelledby="cover-preview-heading">
        <h2 id="cover-preview-heading" className="text-xl font-bold">表紙プレビュー</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">表表紙・背表紙・裏表紙の仕上がりを確認できます。画面用の軽い画像で表示しています。</p>
        {spreadReady ? (
          <CoverSpreadPreview
            title={title}
            editor={editor}
            coverStyle={coverStyle}
            coverColor={coverColor}
            pageCount={previewBodyPageCount}
          />
        ) : (
          <p role="status" className="mt-5 rounded-xl bg-white p-5 text-center text-sm text-amber-900">
            表紙プレビューを準備しています…
          </p>
        )}
        {spreadReady && <p className="mt-3 text-center text-sm text-stone-600">
          {confirmedBodyPageCount === null
            ? `背幅はプレビュー用の仮設定（${PREVIEW_ONLY_BODY_PAGE_COUNT}ページ）です。完成時に確定します。`
            : "背幅は完成した本のページ数に基づいています。"}
        </p>}
        {rendererInternalMode && <button type="button" onClick={downloadRendererCover} disabled={!spreadReady || coverExporting} className="mt-4 rounded bg-stone-800 px-4 py-2 text-white disabled:opacity-50">{coverExporting ? "レンダリング中…" : "見開きカバーPNGをダウンロード"}</button>}
      </section>

      {/* 決定ボタン */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
        }}
      >
        <button
          type="button"
          onClick={handleSave}
          disabled={!bookData}
          style={{
            padding: "15px 40px",
            fontSize: "18px",
            fontWeight: "bold",
            color: "#fff",
            background: "#111",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
          }}
        >
          この表紙で決定
        </button>
      </div>
    </main>
  );
}
