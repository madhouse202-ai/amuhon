"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CoverStyle,
  CoverColor,
  type BookData,
  loadBookData,
  saveBookData,
} from "@/lib/book";

const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";
const COVER_DPI = 350;
const BLEED_MM = 3;
const TRIM_WIDTH_MM = 105;
const TRIM_HEIGHT_MM = 148;
const COVER_PAPERS = [
  ["04", "書籍用紙 白色"],
  ["06", "書籍用紙 クリーム色"],
  ["07", "しらおい"],
  ["09", "モンテシオン"],
  ["11", "マシュマロCoC"],
  ["12", "コート紙1 グロス"],
  ["13", "コート紙2 グロス"],
  ["14", "コート紙1 マット"],
  ["15", "コート紙2 マット"],
  ["16", "HSスノーフォース"],
] as const;

type CoverPageCount = { pageCount: number; worksKey: string };

function addPngResolutionMetadata(png: Uint8Array, dpi: number): Uint8Array {
  // PNG pHYs stores pixels per metre. Canvas output commonly omits intended print DPI.
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Insert pHYs immediately after IHDR.
  const ihdrLength = new DataView(png.buffer, png.byteOffset + 8, 4).getUint32(0);
  const insertAt = 8 + 12 + ihdrLength;
  const output = new Uint8Array(png.length + chunk.length);
  output.set(png.subarray(0, insertAt));
  output.set(chunk, insertAt);
  output.set(png.subarray(insertAt), insertAt + chunk.length);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG画像を生成できませんでした。")), "image/png");
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const sourceLine of text.split(/\r?\n/)) {
    let line = "";
    for (const char of Array.from(sourceLine)) {
      const candidate = line + char;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = char;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function workListKey(book: BookData): string {
  return JSON.stringify(book.works.map((work) => [work.id, work.xhtmlUrl]));
}

export default function CoverPage() {
  const router = useRouter();

  const [bookData, setBookData] = useState<BookData | null>(null);
  const [title, setTitle] = useState("");
  const [editor, setEditor] = useState("");
  const [coverStyle, setCoverStyle] =
    useState<CoverStyle>("classic");
  const [coverColor, setCoverColor] =
    useState<CoverColor>("red");
  const [paperCode, setPaperCode] = useState("");
  const [spineWidth, setSpineWidth] = useState("");
  const [coverPageCount, setCoverPageCount] = useState<CoverPageCount | null>(null);
  const [downloadError, setDownloadError] = useState("");

  const palette = {
    red: { background: "#9e2f2f", foreground: "#fff8eb" },
    blue: { background: "#315f8f", foreground: "#f7f4e9" },
    green: { background: "#47704e", foreground: "#f7f4e9" },
  }[coverColor];

  useEffect(() => {
    const book = loadBookData();

    // Hydrate browser-only localStorage after mount to avoid server/client mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(book.title);
    setBookData(book);
    setEditor(book.editor);
    setCoverStyle(book.coverStyle);
    setCoverColor(book.coverColor);
    try {
      const value = sessionStorage.getItem(COVER_PAGE_COUNT_SESSION_KEY);
      const pageCount = value ? JSON.parse(value) as CoverPageCount : null;
      setCoverPageCount(pageCount);
      setPaperCode(book.coverPaperCode ?? "");
      const savedResultMatches = Boolean(
        pageCount && book.coverPaperCode &&
        book.coverSpineWidthPageCount === pageCount.pageCount &&
        pageCount.worksKey === workListKey(book),
      );
      setSpineWidth(savedResultMatches && typeof book.coverSpineWidthMm === "number"
        ? String(book.coverSpineWidthMm)
        : "");
    } catch {
      setCoverPageCount(null);
      setPaperCode(book.coverPaperCode ?? "");
      setSpineWidth("");
    }
  }, []);

  const currentBook = bookData;
  const pageCountIsCurrent = Boolean(
    coverPageCount && Number.isInteger(coverPageCount.pageCount) &&
    coverPageCount.pageCount > 0 && currentBook && coverPageCount.worksKey === workListKey(currentBook),
  );
  const parsedSpineWidth = Number(spineWidth);
  const validSpineWidth = Number.isFinite(parsedSpineWidth) && parsedSpineWidth > 0;
  const spreadReady = pageCountIsCurrent && Boolean(paperCode) && validSpineWidth;
  const widthMm = validSpineWidth ? TRIM_WIDTH_MM * 2 + parsedSpineWidth + BLEED_MM * 2 : 0;
  const heightMm = TRIM_HEIGHT_MM + BLEED_MM * 2;

  function saveCoverSettings(book = bookData ?? loadBookData()) {
    saveBookData({
      ...book,
      title: title.trim() || "わたしの本",
      editor: editor.trim() || "編者",
      coverStyle,
      coverColor,
      coverPaperCode: paperCode || undefined,
      coverSpineWidthMm: validSpineWidth ? parsedSpineWidth : undefined,
      coverSpineWidthPageCount: pageCountIsCurrent ? coverPageCount?.pageCount : undefined,
    });
    setBookData(loadBookData());
  }

  function handleSave() {
    saveCoverSettings();

    alert("この表紙で決定しました！");

    router.push("/final");
  }

  async function downloadSpreadCover() {
    setDownloadError("");
    if (!spreadReady || !coverPageCount) {
      setDownloadError("本文ページ数、用紙、公式計算結果の背幅を確認してください。");
      return;
    }

    try {
      saveCoverSettings();
      const canvas = document.createElement("canvas");
      const pixelsPerMm = COVER_DPI / 25.4;
      canvas.width = Math.round(widthMm * pixelsPerMm);
      canvas.height = Math.round(heightMm * pixelsPerMm);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画像描画を開始できませんでした。");

      // Right binding: front cover on the left, spine in the center, back cover on the right.
      // The selected background is one continuous fill across all three panels and bleed.
      const scaleX = canvas.width / widthMm;
      const scaleY = canvas.height / heightMm;
      context.scale(scaleX, scaleY);
      context.fillStyle = palette.background;
      context.fillRect(0, 0, widthMm, heightMm);

      const frontX = BLEED_MM;
      const frontCenterX = frontX + TRIM_WIDTH_MM / 2;
      const frontCenterY = heightMm / 2;
      const pxPerMmX = canvas.width / widthMm;
      const pxPerMmY = canvas.height / heightMm;
      const titleFontPx = 20 * COVER_DPI / 72;
      const authorFontPx = 9 * COVER_DPI / 72;
      const maxTextWidthPx = (TRIM_WIDTH_MM - 24) * pxPerMmX;

      // Draw text in the front panel using the existing cover's title/editor hierarchy.
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = palette.foreground;
      context.textAlign = "center";
      context.textBaseline = "alphabetic";
      context.font = `bold ${titleFontPx}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
      const titleLines = wrapCanvasText(context, title.trim() || "わたしの本", maxTextWidthPx);
      const titleLineHeight = titleFontPx * 1.5;
      const titleBlockHeight = titleLines.length * titleLineHeight;
      const authorGapPx = 12 * pxPerMmY;
      const authorHeight = authorFontPx * 1.4;
      const centerYPx = frontCenterY * pxPerMmY;
      const titleTopPx = centerYPx - (titleBlockHeight + authorGapPx + authorHeight) / 2;
      const frontCenterXPx = frontCenterX * pxPerMmX;
      const baselineOffset = titleFontPx * 0.86;
      titleLines.forEach((line, index) => {
        context.fillText(line, frontCenterXPx, titleTopPx + baselineOffset + index * titleLineHeight);
      });
      context.globalAlpha = 0.85;
      context.font = `${authorFontPx}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
      context.fillText(editor.trim() || "編者", frontCenterXPx, titleTopPx + titleBlockHeight + authorGapPx + authorFontPx);
      context.restore();

      if (coverStyle === "classic") {
        context.save();
        context.strokeStyle = palette.foreground;
        context.lineWidth = 0.25 * pxPerMmX;
        context.strokeRect(
          BLEED_MM * pxPerMmX + 6 * pxPerMmX,
          BLEED_MM * pxPerMmY + 6 * pxPerMmY,
          (TRIM_WIDTH_MM - 12) * pxPerMmX,
          (TRIM_HEIGHT_MM - 12) * pxPerMmY,
        );
        context.restore();
      }

      const rawBlob = await canvasBlob(canvas);
      const pngBytes = new Uint8Array(await rawBlob.arrayBuffer());
      const printBytes = addPngResolutionMetadata(pngBytes, COVER_DPI);
      const printBuffer = new ArrayBuffer(printBytes.byteLength);
      new Uint8Array(printBuffer).set(printBytes);
      const printBlob = new Blob([printBuffer], { type: "image/png" });
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
          onChange={(e) => setTitle(e.target.value)}
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
          onChange={(e) => setEditor(e.target.value)}
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
            onClick={() => setCoverStyle("classic")}
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
            onClick={() => setCoverStyle("free")}
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
            onClick={() => setCoverColor("red")}
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
            onClick={() => setCoverColor("blue")}
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
            onClick={() => setCoverColor("green")}
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

      {/* 製本直送.com 表紙作成コース */}
      <section style={{ marginBottom: "45px", padding: "24px", background: "#f5f5f5", borderRadius: "8px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "12px" }}>
          見開きカバー（表紙作成コース）
        </h2>
        <p style={{ marginBottom: "16px", lineHeight: 1.7 }}>
          `/final` で本文を組版してから戻ると、実際の内ページ数を表示します。製本直送.com公式計算ツールで同じページ数・用紙を指定し、表示された背幅を入力してください。未入力・条件不一致のときは画像を出力しません。
        </p>

        {pageCountIsCurrent && coverPageCount ? (
          <p style={{ marginBottom: "16px", fontWeight: "bold" }}>本文ページ数（白紙を含む）：{coverPageCount.pageCount}ページ</p>
        ) : (
          <p role="status" style={{ marginBottom: "16px", color: "#8a3b12" }}>
            本文ページ数がありません。表紙を決定して `/final` で全作品の本文を取得・組版してから、「見開きカバーを作成」で戻ってください。
          </p>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "end", marginBottom: "20px" }}>
          <label style={{ display: "grid", gap: "6px" }}>
            表紙用紙（公式計算ツールと同じ用紙）
            <select
              value={paperCode}
              onChange={(event) => { setPaperCode(event.target.value); setSpineWidth(""); }}
              style={{ minWidth: "250px", padding: "10px", border: "1px solid #aaa", borderRadius: "4px" }}
            >
              <option value="">用紙を選択してください</option>
              {COVER_PAPERS.map(([code, name]) => <option key={code} value={code}>{code} - {name}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: "6px" }}>
            公式計算結果の背幅（mm）
            <input
              type="number"
              min="0"
              step="0.01"
              value={spineWidth}
              onChange={(event) => setSpineWidth(event.target.value)}
              placeholder="例：公式結果を入力"
              style={{ width: "220px", padding: "10px", border: "1px solid #aaa", borderRadius: "4px", boxSizing: "border-box" }}
            />
          </label>
        </div>

        <p style={{ marginBottom: "18px", fontSize: "14px", lineHeight: 1.6 }}>
          右綴じの面順（左から表表紙・背表紙・裏表紙）でプレビューします。仕上がりはA6、四辺に公式案内の3mm塗り足しを加えます。出力はPNG・350dpi・RGBです。
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
              background: palette.background,
              color: palette.foreground,
              boxShadow: "0 3px 12px rgba(0,0,0,.2)",
            }}
          >
            <div style={{ position: "absolute", inset: `${BLEED_MM / heightMm * 100}% ${BLEED_MM / widthMm * 100}%`, display: "flex", border: "1px dashed rgba(255,255,255,.65)", boxSizing: "border-box" }}>
              <div style={{ width: `${TRIM_WIDTH_MM / (210 + parsedSpineWidth) * 100}%`, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", padding: "2%", boxSizing: "border-box", borderRight: "1px solid rgba(255,255,255,.6)", position: "relative" }}>
                {coverStyle === "classic" && <div style={{ position: "absolute", inset: "4%", border: "1px solid currentColor", opacity: .7, pointerEvents: "none" }} />}
                <strong style={{ fontSize: "clamp(9px, 2.1vw, 24px)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{title || "わたしの本"}</strong>
                <span style={{ marginTop: "8%", fontSize: "clamp(7px, 1vw, 14px)" }}>{editor || "編者"}</span>
                <span style={{ position: "absolute", bottom: "3px", fontSize: "10px", opacity: .7 }}>表表紙</span>
              </div>
              <div style={{ flex: `0 0 ${parsedSpineWidth / (210 + parsedSpineWidth) * 100}%`, borderRight: "1px solid rgba(255,255,255,.6)", boxSizing: "border-box", position: "relative" }}>
                <span style={{ position: "absolute", bottom: "3px", left: "50%", transform: "translateX(-50%)", fontSize: "10px", whiteSpace: "nowrap", opacity: .7 }}>背表紙</span>
              </div>
              <div style={{ flex: 1, position: "relative" }}>
                <span style={{ position: "absolute", bottom: "3px", left: "50%", transform: "translateX(-50%)", fontSize: "10px", whiteSpace: "nowrap", opacity: .7 }}>裏表紙</span>
              </div>
            </div>
          </div>
        ) : (
          <div role="status" style={{ padding: "24px", background: "#fff", border: "1px dashed #aaa", marginBottom: "18px" }}>
            本文ページ数、用紙、背幅を揃えると見開きプレビューを表示します。
          </div>
        )}

        {downloadError && <p role="alert" style={{ marginBottom: "12px", color: "#b42318" }}>{downloadError}</p>}
        <button
          type="button"
          onClick={() => void downloadSpreadCover()}
          disabled={!spreadReady}
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
