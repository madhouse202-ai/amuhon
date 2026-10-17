"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import {
  bookLayoutKey,
  loadBookData,
  type BookData,
} from "@/lib/book";
import { isSubmissionPageCount, padPerfectBindingBodyPageCount } from "@/lib/production";
import {
  BODY_RUBY_ENABLED,
  CHARS_PER_COLUMN,
  COLUMNS_PER_PAGE,
  calculateTocLayout,
  splitTextIntoPages,
  unitCharacterCount,
  type LayoutUnit,
  type TocEntry,
} from "@/lib/book-layout";

/* =========================================================
   基本設定
========================================================= */

const AOZORA_REQUEST_TIMEOUT_MS = 30_000;

const PAGE_WIDTH = "105mm";
const PAGE_HEIGHT = "148mm";

const BODY_FONT_SIZE_PT = 8.5;
const BODY_FONT_SIZE = `${BODY_FONT_SIZE_PT}pt`;
const POINT_TO_MM = 25.4 / 72;
const BODY_COLUMN_SAFETY_MM = 2;

const CONTENT_WIDTH = "87mm";

const CONTENT_HEIGHT = "126mm";
// 1字を1emで描画するため、分割上限とCSS上の実寸が一致する。
// 8.5pt × 40字 = 約119.94mm。2mmを印刷・フォント丸めの安全余白にする。
const BODY_COLUMN_HEIGHT = `${(
  BODY_FONT_SIZE_PT * POINT_TO_MM * CHARS_PER_COLUMN +
  BODY_COLUMN_SAFETY_MM
).toFixed(2)}mm`;

const COLUMN_WIDTH = "5.4mm";

/* The body starts below the page header area and has a separate safe bottom. */
const BODY_TOP_OFFSET = "10mm";

/* =========================================================
   型
========================================================= */

type WorkText = {
  id: string;
  title: string;
  author: string;
  text: string;
  error?: string;
};

type PdfOutputMode = "all-pages" | "body-only";
const COVER_PAGE_COUNT_SESSION_KEY = "amuhon-cover-page-count";

const ENABLE_RUBY = BODY_RUBY_ENABLED;

/* =========================================================
   表紙
========================================================= */

function CoverPage({
  data,
}: {
  data: BookData;
}) {
  const palette = {
    red: { background: "#9e2f2f", foreground: "#fff8eb" },
    blue: { background: "#315f8f", foreground: "#f7f4e9" },
    green: { background: "#47704e", foreground: "#f7f4e9" },
  }[data.coverColor];

  return (
    <div
      className={`print-page cover-page cover-page--${data.coverStyle}`}
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background: palette.background,
        color: palette.foreground,
        boxSizing: "border-box",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "serif",
      }}
    >
      <div
        className="cover-page__content"
        style={{
          textAlign: "center",
          padding: "12mm",
        }}
      >
        <div
          style={{
            fontSize: "20pt",
            letterSpacing: "0.08em",
            marginBottom: "12mm",
          }}
        >
          {data.title}
        </div>

        <div
          style={{
            fontSize: "9pt",
            color: "inherit",
            opacity: 0.85,
          }}
        >
          {data.editor}
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   共通ページ
========================================================= */

function VerticalPage({
  children,
  pageNumber,
}: {
  children?: ReactNode;
  pageNumber?: number;
}) {
  return (
    <div
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background: "#f8f3df",
        boxSizing: "border-box",
        position: "relative",
        overflow: "visible",
        fontFamily: "serif",
      }}
    >
      {children}

      {pageNumber !== undefined ? (
        <div
          className="print-page__number"
        >
          {pageNumber}
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   タイトルページ
========================================================= */

function TitlePage({
  title,
  author,
  pageNumber,
}: {
  title: string;
  author?: string;
  pageNumber?: number;
}) {
  return (
    <VerticalPage
      pageNumber={pageNumber}
    >
      <div
        style={{
          width: CONTENT_WIDTH,
          height: CONTENT_HEIGHT,
          margin: "0 auto",
          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "center",
          justifyContent: "center",
          gap: "8mm",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
        }}
      >
        <div
          style={{
            fontSize: "13pt",
            lineHeight: 1.8,
            letterSpacing: "0.04em",
          }}
        >
          {title}
        </div>

        {author ? (
          <div
            style={{
              fontSize: "8pt",
              color: "#555",
              lineHeight: 1.8,
            }}
          >
            {author}
          </div>
        ) : null}
      </div>
    </VerticalPage>
  );
}

/* =========================================================
   目次
========================================================= */



function TableOfContents({
  works,
  entries,
}: {
  works: WorkText[];
  entries: TocEntry[];
}) {
  return (
    <VerticalPage>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "center",
          justifyContent: "center",
          gap: "3mm",
          writingMode: "vertical-rl",
          textOrientation: "upright",
          fontFamily: "serif",
          boxSizing: "border-box",
          padding: "12mm",
        }}
      >
        {/* 作品タイトルとページ番号を、ひとつの縦書き列にする */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "3mm",
            flexShrink: 0,
          }}
        >
          {entries.map(({ workIndex, pageNumber }) => {
            const work = works[workIndex];
            return (
              <div
                key={work.id}
                style={{
                  writingMode: "vertical-rl",
                  textOrientation: "upright",
                  fontSize: "8.5pt",
                  lineHeight: 1.6,
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                  height: "124mm",
                  flex: "0 0 auto",
                }}
              >
                <span>
                  {work.title}
                  {work.author?.trim() ? `　${work.author.trim()}` : ""}
                  {"　"}
                </span>
                <span
                  style={{
                    fontSize: "7.5pt",
                    color: "#a15b46",
                  }}
                >
                  {pageNumber}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </VerticalPage>
  );
}
/* =========================================================
   本文ページ
========================================================= */

function BodyPage({
  columns,
  pageNumber,
}: {
  columns: LayoutUnit[][];
  pageNumber: number;
}) {
  const paddedColumns: Array<
    LayoutUnit[] | null
  > = [
    ...columns,
    ...Array(
      Math.max(
        0,
        COLUMNS_PER_PAGE -
          columns.length,
      ),
    ).fill(null),
  ];

  return (
    <VerticalPage
      pageNumber={pageNumber}
    >
      <div
        className="body-content"
        style={{
          width: CONTENT_WIDTH,

          height: BODY_COLUMN_HEIGHT,
          position: "absolute",
          top: BODY_TOP_OFFSET,
          left: "50%",
          transform: "translateX(-50%)",

          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "flex-start",
          justifyContent: "flex-start",

          overflow: "visible",
        }}
      >
        {paddedColumns.map(
          (
            column,
            columnIndex,
          ) => (
            <div
              key={columnIndex}
              lang="ja"
              style={{
                width: COLUMN_WIDTH,

                height: BODY_COLUMN_HEIGHT,
                position: "relative",

                flex: `0 0 ${COLUMN_WIDTH}`,

                boxSizing: "border-box",

                writingMode:
                  "vertical-rl",

                textOrientation:
                  "mixed",

                fontFamily: "serif",

                fontSize:
                  BODY_FONT_SIZE,

                lineHeight: 1,
                letterSpacing: "0",

                lineBreak: "strict",

                wordBreak: "normal",

                overflowWrap:
                  "normal",

                whiteSpace:
                  "nowrap",

                /*
                 * ここで切らない。
                 */
                overflow: "visible",
              }}
            >
              {column
                ? column.map((unit, unitIndex) => {
                    const inlineOffset = column
                      .slice(0, unitIndex)
                      .reduce(
                        (total, previous) => total + unitCharacterCount(previous),
                        0,
                      );

                    return (
                      <span
                        key={unitIndex}
                        className="print-character-cell"
                        style={{
                          insetInlineStart: `${inlineOffset}em`,
                          inlineSize: `${unitCharacterCount(unit)}em`,
                        }}
                      >
                        {unit.text}
                        {unit.ruby ? (
                          <span className="print-character-cell__ruby" aria-hidden="true">
                            {unit.ruby}
                          </span>
                        ) : null}
                      </span>
                    );
                  })
                : null}
            </div>
          ),
        )}
      </div>
    </VerticalPage>
  );
}

/* =========================================================
   奥付
========================================================= */

function ColophonPage({
  pageNumber,
}: {
  pageNumber: number;
}) {
  return (
    <VerticalPage
      pageNumber={pageNumber}
    >
      <div
        style={{
          width: CONTENT_WIDTH,
          height: CONTENT_HEIGHT,
          margin: "0 auto",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          fontSize: "7.5pt",
          lineHeight: 1.8,
          paddingTop: "15mm",
          boxSizing: "border-box",
        }}
      >
        <div>
          編む本
        </div>
      </div>
    </VerticalPage>
  );
}

/* =========================================================
   Final Page
========================================================= */

export default function FinalPage() {
  const router = useRouter();
  const [
    data,
    setData,
  ] = useState<BookData | null>(
    null,
  );

  const [
    works,
    setWorks,
  ] = useState<WorkText[]>([]);

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    error,
    setError,
  ] = useState("");

  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [isPrinting, setIsPrinting] = useState(false);
  const [pdfOutputMode, setPdfOutputMode] = useState<PdfOutputMode>("all-pages");
  const printingRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);

  const loadWorks = async (book: BookData) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError("");
    setWorks([]);
    setProgress({ completed: 0, total: book.works.length });

    const results: WorkText[] = [];
    for (const work of book.works) {
      if (controller.signal.aborted) return;
      try {
        if (!work.xhtmlUrl) {
          throw new Error("本文URLが登録されていません。");
        }
        const requestController = new AbortController();
        const timeoutId = window.setTimeout(
          () => requestController.abort(),
          AOZORA_REQUEST_TIMEOUT_MS,
        );
        const abortRequest = () => requestController.abort();
        controller.signal.addEventListener("abort", abortRequest, { once: true });
        let response: Response;
        let result: { error?: string; text?: unknown };
        try {
          response = await fetch(
            `/api/aozora?url=${encodeURIComponent(work.xhtmlUrl)}${ENABLE_RUBY ? "&ruby=1" : ""}`,
            { cache: "no-store", signal: requestController.signal },
          );
          result = await response.json();
        } catch (fetchError) {
          if (requestController.signal.aborted) {
            throw new Error(controller.signal.aborted
              ? "本文取得が中断されました。"
              : "本文取得がタイムアウトしました（30秒）。再試行してください。");
          }
          throw fetchError;
        } finally {
          window.clearTimeout(timeoutId);
          controller.signal.removeEventListener("abort", abortRequest);
        }
        if (!response.ok) {
          throw new Error(result.error ?? "本文の取得に失敗しました。");
        }
        if (typeof result.text !== "string" || !result.text.trim()) {
          throw new Error("取得した本文が空でした。");
        }
        results.push({
          id: work.id,
          title: work.title,
          author: work.author,
          text: result.text,
        });
      } catch (workError) {
        if (controller.signal.aborted) return;
        results.push({
          id: work.id,
          title: work.title,
          author: work.author,
          text: "",
          error: workError instanceof Error
            ? workError.message
            : "本文の取得に失敗しました。",
        });
      }
      if (sequence !== loadSequenceRef.current) return;
      setWorks([...results]);
      setProgress({ completed: results.length, total: book.works.length });
    }
    if (sequence === loadSequenceRef.current) {
      setLoading(false);
      loadControllerRef.current = null;
    }
  };

  /* =======================================================
     青空文庫本文取得
  ======================================================= */

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const book = loadBookData();
      setData(book);
      if (book.works.length === 0) {
        setError("本に作品がありません。作品を選んでからPDFを作成してください。");
        setLoading(false);
      } else {
        void loadWorks(book);
      }
    });
    return () => {
      active = false;
      loadControllerRef.current?.abort();
      loadSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const resetPrinting = () => {
      printingRef.current = false;
      setIsPrinting(false);
      setPdfOutputMode("all-pages");
    };
    window.addEventListener("afterprint", resetPrinting);
    return () => window.removeEventListener("afterprint", resetPrinting);
  }, []);

  const retryFailedWorks = async () => {
    if (!data || loading) return;
    await loadWorks(data);
  };

  const canPrint = Boolean(data && !loading && !error && works.length > 0 &&
    works.every((work) => !work.error && work.text.trim().length > 0));

  const savePdf = (mode: PdfOutputMode) => {
    if (!canPrint || printingRef.current) return;
    printingRef.current = true;
    setPdfOutputMode(mode);
    setIsPrinting(true);
    window.requestAnimationFrame(() => window.print());
  };

  const openSpreadCover = () => {
    if (!canPrint || !data) return;
    sessionStorage.setItem(COVER_PAGE_COUNT_SESSION_KEY, JSON.stringify({
      bodyPdfPageCount: bodyPages.length - 2,
      worksKey: bookLayoutKey(data),
    }));
    router.push("/cover");
  };

  /* =======================================================
     ローディング
  ======================================================= */

  if (loading) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#eee",
          fontFamily:
            "sans-serif",
        }}
      >
        <div>
          本文を取得して組版しています……
          <p aria-live="polite">{progress.completed} / {progress.total} 作品</p>
        </div>
      </main>
    );
  }

  /* =======================================================
     エラー
  ======================================================= */

  if (error) {
    return (
      <main
        style={{
          padding: "40px",
          fontFamily:
            "sans-serif",
        }}
      >
        <h1>エラー</h1>

        <p>{error}</p>
      </main>
    );
  }

  if (!data) {
    return null;
  }

  /* =======================================================
     ページ生成
  ======================================================= */

  const bodyPages: ReactNode[] =
    [];

  /*
   * 1. 表紙
   */

  bodyPages.push(
    <CoverPage
      key="cover"
      data={data}
    />,
  );

  /*
   * 2. 本全体のタイトルページ
   */

  bodyPages.push(
    <TitlePage
      key="book-title"
      title={data.title}
      author={data.editor}
      pageNumber={1}
    />,
  );

  /*
   * 各作品の本文ページを計算
   */

  const workPageData =
    works.map((work) => {
      const pages =
        splitTextIntoPages(
          work.text,
        );

      return {
        work,
        pages,
      };
    });

  const tocLayout = calculateTocLayout(works, workPageData.map((item) => item.pages.length));
  const tocPageCount = tocLayout.pages.length;
  const tocPageNumbers = tocLayout.pageNumbers;
  const currentPageNumber = tocLayout.colophonPageNumber;

  /*
   * 3. 目次
   */

  for (let tocPageIndex = 0; tocPageIndex < tocPageCount; tocPageIndex += 1) {
    bodyPages.push(
      <TableOfContents
        key={`toc-${tocPageIndex}`}
        works={works}
        entries={tocLayout.pages[tocPageIndex]}
      />,
    );
  }

  /*
   * 4. 各作品
   */

  for (
    let workIndex = 0;
    workIndex <
    workPageData.length;
    workIndex += 1
  ) {
    const item =
      workPageData[
        workIndex
      ];

    /*
     * 作品タイトル
     */

    bodyPages.push(
      <TitlePage
        key={`${item.work.id}-title`}
        title={
          item.work.title
        }
        author={
          item.work.author
        }
        pageNumber={
          tocPageNumbers[
            workIndex
          ]
        }
      />,
    );

    /*
     * 本文
     */

    for (
      let pageIndex = 0;
      pageIndex <
      item.pages.length;
      pageIndex += 1
    ) {
      bodyPages.push(
        <BodyPage
          key={`${item.work.id}-body-${pageIndex}`}
          columns={
            item.pages[
              pageIndex
            ]
          }
          pageNumber={
            tocPageNumbers[
              workIndex
            ] +
            1 +
            pageIndex
          }
        />,
      );
    }
  }

  /*
   * 5. 奥付
   */

  const colophonPageNumber =
    currentPageNumber;

  bodyPages.push(
    <ColophonPage
      key="colophon"
      pageNumber={
        colophonPageNumber
      }
    />,
  );

  /* Add trailing blanks so the perfect-bound body PDF has an 8-page multiple. */

  const contentPageCount =
    bodyPages.length - 1;

  const finalBodyPdfPageCount = padPerfectBindingBodyPageCount(contentPageCount) ?? contentPageCount;
  const paddingPageCount = finalBodyPdfPageCount - contentPageCount;

  for (let blankIndex = 0; blankIndex < paddingPageCount; blankIndex += 1) {
    bodyPages.push(
      <VerticalPage
        key={`perfect-binding-blank-${blankIndex}`}
      />,
    );
  }

  /*
   * 7. 裏表紙
   */

  bodyPages.push(
    <div
      key="back-cover"
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background: "#f8f3df",
      }}
    />,
  );

  const submissionPageCount = bodyPages.length - 2;
  const submissionPageCountValid = isSubmissionPageCount(submissionPageCount);
  const actualWorkBodyPageCount = workPageData.reduce((total, item) => total + item.pages.length, 0);

  /* =======================================================
     表示
  ======================================================= */

  return (
    <>
      <main
        className={`print-root${pdfOutputMode === "body-only" ? " print-root--body-only" : ""}`}
        style={{
          minHeight: "100vh",
          background: "#ddd",
          padding: "24px",
          boxSizing:
            "border-box",
          display: "flex",
          flexDirection:
            "column",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <section className="print-controls mb-6 w-full max-w-3xl rounded-xl bg-white p-6 text-stone-800 shadow" aria-label="PDF出力">
          <h1 className="text-xl font-bold">完成した本</h1>
          {canPrint && (
            <p className="mt-2 text-sm text-stone-600" role="status">
              実組版結果：作品本文合計 {actualWorkBodyPageCount} ページ／本文PDF {submissionPageCount} ページ（目次・作品タイトル・奥付・末尾白紙を含む）
            </p>
          )}
          {works.some((work) => work.error) && (
            <div role="alert" className="print-errors mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
              <p>本文を取得できなかった作品があります。全作品の本文を取得するまでPDFを保存できません。</p>
              <ul>
                {works.filter((work) => work.error).map((work) => (
                  <li key={work.id}><strong>{work.title}</strong>：{work.error}</li>
                ))}
              </ul>
              <button className="mt-3 rounded bg-stone-800 px-4 py-2 text-white disabled:opacity-50" type="button" onClick={retryFailedWorks} disabled={loading}>
                {loading ? "再取得中…" : "作品本文を再取得"}
              </button>
            </div>
          )}
          {canPrint ? (
            <div className="mt-4 flex flex-wrap gap-3">
              <button className="rounded bg-stone-800 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={() => savePdf("all-pages")} disabled={isPrinting}>
                {isPrinting && pdfOutputMode === "all-pages" ? "印刷画面を準備しています…" : "全ページPDFを保存"}
              </button>
              <button className="rounded border border-stone-800 px-5 py-3 font-bold text-stone-800 disabled:opacity-50" type="button" onClick={() => savePdf("body-only")} disabled={isPrinting || !submissionPageCountValid}>
                {isPrinting && pdfOutputMode === "body-only" ? "印刷画面を準備しています…" : "本文PDFを保存（表紙なし）"}
              </button>
              <button className="rounded border border-stone-500 px-5 py-3 font-bold text-stone-800 disabled:opacity-50" type="button" onClick={openSpreadCover} disabled={isPrinting || !submissionPageCountValid}>
                見開きカバーを作成
              </button>
            </div>
          ) : (
            <p>PDFを保存するには、すべての作品本文の取得が必要です。</p>
          )}
          {canPrint && !submissionPageCountValid && (
            <p role="alert" className="mt-4 text-red-800">
              標準入稿データは、末尾白紙を含め20〜500ページの範囲です。既存の8ページ単位調整を維持するため実際の出力範囲は24〜496ページです。現在の本文PDFは{submissionPageCount}ページのため、本文PDFとカバーの出力を停止しています。
            </p>
          )}
          <p>印刷画面で用紙サイズを A6、保存先を「PDFに保存」にしてください。</p>
        </section>

        {bodyPages.map(
          (page, index) => (
            <div
              key={index}
              className={`print-sheet${index === 0 ? " print-sheet--front-cover" : index === bodyPages.length - 1 ? " print-sheet--back-cover" : ""}`}
              style={{
                boxShadow:
                  "0 2px 10px rgba(0,0,0,0.12)",
              }}
            >
              {page}
            </div>
          ),
        )}
      </main>
    </>
  );
}
