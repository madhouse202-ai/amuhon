"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreationProgress } from "@/app/creation-progress";
import { DraftSaveStatus } from "@/app/draft-save-status";
import {
  CoverStyle,
  CoverColor,
  type BookData,
  bookLayoutKey,
} from "@/lib/book";
import { useBookDraftAutosave } from "@/lib/use-book-draft-autosave";
import {
  BOOK_PRODUCTION,
  calculateCoverLayout,
  calculateSpineTextLayout,
  isSubmissionPageCount,
} from "@/lib/production";
import { createSpreadCoverPngBlob } from "@/lib/cover-renderer";

const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";
const BLEED_MM = BOOK_PRODUCTION.bleedMm;
const TRIM_WIDTH_MM = BOOK_PRODUCTION.trimWidthMm;
const TRIM_HEIGHT_MM = BOOK_PRODUCTION.trimHeightMm;

type CoverPageCount = { bodyPdfPageCount: number; worksKey: string };

export default function CoverPage() {
  const router = useRouter();
  const { draft, updateDraft, loadState, saveState, flushDraft } = useBookDraftAutosave();

  const bookData: BookData | null = loadState === "ready" ? draft : null;
  const title = draft.title;
  const editor = draft.editor;
  const coverStyle: CoverStyle = draft.coverStyle;
  const coverColor: CoverColor = draft.coverColor;
  const [coverPageCount, setCoverPageCount] = useState<CoverPageCount | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [showSpineText, setShowSpineText] = useState(true);

  const palette = {
    red: { background: "#9e2f2f", foreground: "#fff8eb" },
    blue: { background: "#315f8f", foreground: "#f7f4e9" },
    green: { background: "#47704e", foreground: "#f7f4e9" },
  }[coverColor];

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
    coverPageCount.worksKey === bookLayoutKey(currentBook, title, editor),
  );
  const pageCountIsEligible = Boolean(
    pageCountMatchesBook && coverPageCount &&
    isSubmissionPageCount(coverPageCount.bodyPdfPageCount),
  );
  const layout = pageCountMatchesBook && coverPageCount
    ? calculateCoverLayout(coverPageCount.bodyPdfPageCount)
    : null;
  const spreadReady = pageCountIsEligible && layout !== null;
  const widthMm = layout?.coverWidthMm ?? 0;
  const heightMm = layout?.coverHeightMm ?? TRIM_HEIGHT_MM + BLEED_MM * 2;
  const spineTextLayout = spreadReady && coverPageCount
    ? calculateSpineTextLayout(coverPageCount.bodyPdfPageCount, title || "わたしの本", editor || "編者")
    : null;

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

  async function downloadSpreadCover() {
    setDownloadError("");
    if (!spreadReady || !coverPageCount || !layout) {
      setDownloadError("本文PDFのページ数が不一致または対象範囲外です。最終ページ数を確認してください。");
      return;
    }

    try {
      if (!saveCoverSettings()) {
        setDownloadError("編集内容を保存できませんでした。保存状態を確認してから、もう一度お試しください。");
        return;
      }
      const printBlob = await createSpreadCoverPngBlob({
        title,
        editor,
        coverStyle,
        coverColor,
      }, coverPageCount.bodyPdfPageCount, showSpineText);
      const url = URL.createObjectURL(printBlob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "amuhon-cover-spread.png";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "カバー画像の出力に失敗しました。");
    }
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

      {/* 見開きカバー */}
      <section style={{ marginBottom: "45px", padding: "24px", background: "#f5f5f5", borderRadius: "8px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "12px" }}>
          見開きカバー
        </h2>
        <p style={{ marginBottom: "16px", lineHeight: 1.7 }}>
          本文ページ数に合わせて背幅を調整します。タイトルや色を変えながら、表紙の見え方を確認してください。
        </p>

        {pageCountMatchesBook && coverPageCount ? (
          <p style={{ marginBottom: "12px", fontWeight: "bold" }}>本文PDFの最終ページ数：{coverPageCount.bodyPdfPageCount}ページ</p>
        ) : (
          <p role="status" style={{ marginBottom: "16px", color: "#8a3b12" }}>
            本文ページ数を確認できません。完成した本の画面から表紙作成へ進んでください。
          </p>
        )}
        {pageCountMatchesBook && layout && (
          <div style={{ marginBottom: "16px", lineHeight: 1.7 }}>
            <p>背幅：約{layout.spineWidthMm.toFixed(2)}mm</p>
          </div>
        )}
        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <input type="checkbox" checked={showSpineText} onChange={(event) => setShowSpineText(event.target.checked)} />
          背表紙にタイトル・編者名を表示
        </label>
        {showSpineText && spreadReady && !spineTextLayout && (
          <p role="status" style={{ marginBottom: "14px", color: "#8a3b12" }}>
            背表紙に文字が収まらないため、背表紙のタイトルと編者名を省略します。
          </p>
        )}
        {pageCountMatchesBook && !pageCountIsEligible && (
          <p role="alert" style={{ marginBottom: "16px", color: "#8a3b12" }}>
            現在の本文ページ数では製本用の表紙を作成できません。作品を追加・調整して、完成した本の画面からもう一度お試しください。
          </p>
        )}

        <p style={{ marginBottom: "18px", fontSize: "14px", lineHeight: 1.6 }}>
          表紙・背表紙・裏表紙を並べた仕上がりを確認できます。
        </p>

        {spreadReady ? (
          <div
            aria-label="見開きカバープレビュー"
            style={{
              position: "relative",
              width: "100%",
              maxWidth: "760px",
              margin: "0 auto 18px",
              aspectRatio: `${widthMm} / ${heightMm}`,
              containerType: "inline-size",
              background: palette.background,
              color: palette.foreground,
              boxShadow: "0 3px 12px rgba(0,0,0,.2)",
            }}
          >
            <div style={{ position: "absolute", inset: `${BLEED_MM / heightMm * 100}% ${BLEED_MM / widthMm * 100}%`, display: "flex", border: "1px dashed rgba(255,255,255,.65)", boxSizing: "border-box" }}>
              <div style={{ width: `${(layout?.panels.front.widthMm ?? TRIM_WIDTH_MM) / (widthMm - BLEED_MM * 2) * 100}%`, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "2%", boxSizing: "border-box", borderRight: "1px solid rgba(255,255,255,.6)", position: "relative" }}>
                {coverStyle === "classic" && <div style={{ position: "absolute", inset: "4%", border: "1px solid currentColor", opacity: .7, pointerEvents: "none" }} />}
                <strong style={{ fontSize: "clamp(9px, 2.1vw, 24px)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{title || "わたしの本"}</strong>
                <span style={{ marginTop: "8%", fontSize: "clamp(7px, 1vw, 14px)" }}>{editor || "編者"}</span>
                <span style={{ position: "absolute", bottom: "3px", fontSize: "10px", opacity: .7 }}>表表紙</span>
              </div>
              <div style={{ flex: `0 0 ${(layout?.panels.spine.widthMm ?? 0) / (widthMm - BLEED_MM * 2) * 100}%`, borderRight: "1px solid rgba(255,255,255,.6)", boxSizing: "border-box", position: "relative", display: "flex", justifyContent: "center", alignItems: "center" }}>
                {showSpineText && spineTextLayout ? (
                  <span style={{ writingMode: "vertical-rl", textOrientation: "upright", fontSize: `${spineTextLayout.fontSizeMm / widthMm * 100}cqw`, lineHeight: spineTextLayout.lineHeightMm / spineTextLayout.fontSizeMm, whiteSpace: "pre", maxHeight: `${spineTextLayout.lineHeightMm * Array.from(spineTextLayout.text).length / heightMm * 100}%` }}>
                    {spineTextLayout.text}
                  </span>
                ) : (
                  <span style={{ position: "absolute", bottom: "3px", left: "50%", transform: "translateX(-50%)", fontSize: "10px", whiteSpace: "nowrap", opacity: .7 }}>背表紙（文字なし）</span>
                )}
              </div>
              <div style={{ flex: 1, position: "relative" }}>
                <span style={{ position: "absolute", bottom: "3px", left: "50%", transform: "translateX(-50%)", fontSize: "10px", whiteSpace: "nowrap", opacity: .7 }}>裏表紙</span>
              </div>
            </div>
          </div>
        ) : (
          <div role="status" style={{ padding: "24px", background: "#fff", border: "1px dashed #aaa", marginBottom: "18px" }}>
            本文ページ数が確認できると、見開きカバーを表示します。
          </div>
        )}

        {downloadError && <p role="alert" style={{ marginBottom: "12px", color: "#b42318" }}>{downloadError}</p>}
        <button
          type="button"
          onClick={() => void downloadSpreadCover()}
          disabled={!spreadReady || !bookData}
          style={{ padding: "12px 20px", border: "none", borderRadius: "6px", background: spreadReady ? "#111" : "#888", color: "#fff", fontWeight: "bold", cursor: spreadReady ? "pointer" : "not-allowed" }}
        >
          見開きカバーPNGをダウンロード
        </button>
      </section>

      {/* プレビュー */}
      <section
        style={{
          marginBottom: "45px",
          padding: "30px",
          background: "#f5f5f5",
          borderRadius: "8px",
        }}
      >
        <h2
          style={{
            fontSize: "20px",
            fontWeight: "bold",
            marginBottom: "20px",
          }}
        >
          表紙プレビュー
        </h2>

        <div
          style={{
            width: "280px",
            height: "395px",
            margin: "0 auto",
            background:
              coverColor === "red"
                ? "#9e2f2f"
                : coverColor === "blue"
                ? "#315f8f"
                : "#47704e",
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "30px",
            boxSizing: "border-box",
            textAlign: "center",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          }}
        >
          <div
            style={{
              fontSize: "28px",
              fontWeight: "bold",
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              lineHeight: 1.5,
              minHeight: "220px",
            }}
          >
            {title || "わたしの本"}
          </div>

          <div
            style={{
              marginTop: "30px",
              fontSize: "16px",
            }}
          >
            {editor || "編者"}
          </div>
        </div>
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
