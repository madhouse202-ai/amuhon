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
import {
  FINAL_PRELOADED_WORKS_SESSION_KEY,
  FINAL_TYPOGRAPHY_SESSION_KEY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
  parseFinalPreviewWorkTexts,
  type FinalBodyTypography,
  type FinalPreviewWorkText,
} from "@/lib/final-typography-preview";
import { ensureNotoSerifJpLoaded } from "@/lib/noto-serif-jp-preview";
import { CreationProgress } from "@/app/creation-progress";
import { CoverFrontPreview } from "@/app/cover-front-preview";
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

function printFontFamily(bodyTypography: FinalBodyTypography): string {
  return bodyTypography === "noto-serif-jp" ? '"Noto Serif JP", serif' : "serif";
}

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

function isIsolatedPdfRenderer(): boolean {
  return typeof window !== "undefined" &&
    (window as Window & { __AMUHON_PDF_RENDERER_V1__?: boolean }).__AMUHON_PDF_RENDERER_V1__ === true;
}

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
  bodyTypography = "serif",
}: {
  children?: ReactNode;
  pageNumber?: number;
  bodyTypography?: FinalBodyTypography;
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
        fontFamily: printFontFamily(bodyTypography),
      }}
    >
      {children}

      {pageNumber !== undefined ? (
        <div
          className="print-page__number"
          data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "page-number" : undefined}
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
  bodyTypography,
}: {
  title: string;
  author?: string;
  pageNumber?: number;
  bodyTypography: FinalBodyTypography;
}) {
  return (
    <VerticalPage
      pageNumber={pageNumber}
      bodyTypography={bodyTypography}
    >
      <div
        className="print-title-page__content"
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
        }}
      >
        <div
          data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "title" : undefined}
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
            data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "title" : undefined}
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
  bodyTypography,
}: {
  works: WorkText[];
  entries: TocEntry[];
  bodyTypography: FinalBodyTypography;
}) {
  return (
    <VerticalPage bodyTypography={bodyTypography}>
      <div
        className="print-toc-page__content"
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
          fontFamily: printFontFamily(bodyTypography),
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
                <span data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "toc" : undefined}>
                  {work.title}
                  {work.author?.trim() ? `　${work.author.trim()}` : ""}
                  {"　"}
                </span>
                <span
                  data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "page-number" : undefined}
                  style={{
                    fontSize: "7.5pt",
                    color: "#a15b46",
                    textOrientation: "mixed",
                    textCombineUpright: "all",
                    whiteSpace: "nowrap",
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
  bodyTypography,
}: {
  columns: LayoutUnit[][];
  pageNumber: number;
  bodyTypography: FinalBodyTypography;
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
      bodyTypography={bodyTypography}
    >
      <div
        className="body-content"
        data-body-typography={bodyTypography}
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

                fontFamily: bodyTypography === "noto-serif-jp" ? '"Noto Serif JP", serif' : "serif",

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
                        data-unit-character-count={unitCharacterCount(unit)}
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

function SourcePage({
  works,
  pageNumber,
  pageIndex,
  pageCount,
  bodyTypography,
}: {
  works: BookData["works"];
  pageNumber: number;
  pageIndex: number;
  pageCount: number;
  bodyTypography: FinalBodyTypography;
}) {
  return (
    <section className="print-page print-sources-page relative" data-source-page="true" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, background: "#f8f3df", padding: "9mm 9mm 14mm", boxSizing: "border-box", fontFamily: printFontFamily(bodyTypography), color: "#28241f" }}>
      <h2 className="mb-3 border-b border-stone-400 pb-2 text-center text-[10pt] font-semibold">収録作品と出典</h2>
      <p className="mb-2 text-[6.5pt] leading-[1.4]">本文・書誌情報：青空文庫公開カタログおよび各図書カード。</p>
      <ol className="space-y-2 text-[6.5pt] leading-[1.35]" data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "sources" : undefined}>
        {works.map((work, index) => {
          const metadata = work.sourceMetadata;
          const contributors = work.contributors?.filter((person) => !["著者", "作者", "原著者"].includes(person.role)) ?? [];
          const cardPath = (() => {
            try {
              const url = new URL(work.cardUrl);
              return url.protocol === "https:" && ["www.aozora.gr.jp", "aozora.gr.jp"].includes(url.hostname) ? url.pathname : "";
            } catch { return ""; }
          })();
          return (
            <li key={`${work.id}-${index}`} className="break-words">
              <p><span className="mr-1">{(pageIndex * 4) + index + 1}.</span><strong>{work.title}</strong> — {work.author || "著者情報なし"}</p>
              {contributors.length > 0 && <p>{contributors.map((person) => `${person.role}：${person.name}`).join("／")}</p>}
              {metadata && [metadata.firstPublication, metadata.baseText, metadata.basePublisher, metadata.inputter, metadata.proofreader].some(Boolean) && (
                <p>{[
                  metadata.firstPublication && `初出：${metadata.firstPublication}`,
                  metadata.baseText && `底本：${metadata.baseText}`,
                  metadata.basePublisher && `出版社：${metadata.basePublisher}`,
                  metadata.inputter && `入力：${metadata.inputter}`,
                  metadata.proofreader && `校正：${metadata.proofreader}`,
                ].filter(Boolean).join("／")}</p>
              )}
              <p>青空文庫 作品ID {work.id}：{cardPath || "図書カード情報"}</p>
              {work.rightsNotice && (work.catalogRights
                ? <p>青空文庫作成ファイル：{work.rightsNotice}</p>
                : <p>利用条件：{work.rightsNotice}</p>)}
            </li>
          );
        })}
      </ol>
      <p className="absolute bottom-[8mm] inset-x-0 text-center text-[6pt] text-stone-600">{pageIndex + 1} / {pageCount}</p>
      <div className="print-page__number" data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "page-number" : undefined} aria-hidden="true">{pageNumber}</div>
    </section>
  );
}

/* =========================================================
   奥付
========================================================= */

function ColophonPage({
  pageNumber,
  bodyTypography,
}: {
  pageNumber: number;
  bodyTypography: FinalBodyTypography;
}) {
  return (
    <VerticalPage
      pageNumber={pageNumber}
      bodyTypography={bodyTypography}
    >
      <div
        className="print-colophon-page__content"
        style={{
          width: CONTENT_WIDTH,
          height: CONTENT_HEIGHT,
          margin: "0 auto",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontFamily: printFontFamily(bodyTypography),
          fontSize: "7.5pt",
          lineHeight: 1.8,
          paddingTop: "15mm",
          boxSizing: "border-box",
        }}
      >
        <div data-noto-inspection-kind={bodyTypography === "noto-serif-jp" ? "colophon" : undefined}>
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
  const [bodyTypography, setBodyTypography] = useState<FinalBodyTypography>("serif");
  const loadSequenceRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const previewSessionSnapshotRef = useRef<{
    typographyRequest: string | null;
    preloadedWorksJson: string | null;
  } | null>(null);

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
    const initializeFinalPage = async () => {
      const book = loadBookData();
      setData(book);

      const allowRendererSnapshot = process.env.NODE_ENV === "development" || isIsolatedPdfRenderer();
      let previewSessionSnapshot = previewSessionSnapshotRef.current;
      if (allowRendererSnapshot && previewSessionSnapshot === null) {
        previewSessionSnapshot = {
          typographyRequest: sessionStorage.getItem(FINAL_TYPOGRAPHY_SESSION_KEY),
          preloadedWorksJson: sessionStorage.getItem(FINAL_PRELOADED_WORKS_SESSION_KEY),
        };
        previewSessionSnapshotRef.current = previewSessionSnapshot;
        sessionStorage.removeItem(FINAL_TYPOGRAPHY_SESSION_KEY);
        sessionStorage.removeItem(FINAL_PRELOADED_WORKS_SESSION_KEY);
      }
      let preloadedWorks: FinalPreviewWorkText[] | null = null;
      const typographyRequest = allowRendererSnapshot
        ? previewSessionSnapshot?.typographyRequest ?? null
        : null;
      const preloadedWorksJson = allowRendererSnapshot
        ? previewSessionSnapshot?.preloadedWorksJson ?? null
        : null;

      if (preloadedWorksJson !== null) {
        try {
          const parsed = parseFinalPreviewWorkTexts(JSON.parse(preloadedWorksJson) as unknown, book);
          if (!parsed) throw new Error("invalid_preview_snapshot");
          preloadedWorks = parsed;
        } catch {
          if (active) {
            setError("検証用の本文スナップショットが選択作品と一致しません。PDFを作成できません。");
            setLoading(false);
          }
          return;
        }
      }

      if (typographyRequest === "noto-serif-jp") {
        try {
          await ensureNotoSerifJpLoaded();
          if (!active) return;
          setBodyTypography("noto-serif-jp");
        } catch {
          if (active) {
            setError(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
            setLoading(false);
          }
          return;
        }
      }

      if (!active) return;
      if (book.works.length === 0) {
        setError("本に作品がありません。作品を選んでからPDFを作成してください。");
        setLoading(false);
      } else if (preloadedWorks) {
        setWorks(preloadedWorks);
        setProgress({ completed: preloadedWorks.length, total: book.works.length });
        setLoading(false);
      } else {
        void loadWorks(book);
      }
    };
    void initializeFinalPage();
    return () => {
      active = false;
      loadControllerRef.current?.abort();
      loadSequenceRef.current += 1;
    };
  }, []);

  const retryFailedWorks = async () => {
    if (!data || loading) return;
    await loadWorks(data);
  };

  const canPrint = Boolean(data && !loading && !error && works.length > 0 &&
    works.every((work) => !work.error && work.text.trim().length > 0));

  const openSpreadCover = () => {
    if (!canPrint || !data) return;
    sessionStorage.setItem(COVER_PAGE_COUNT_SESSION_KEY, JSON.stringify({
      bodyPdfPageCount: bodyPages.length - 2,
      worksKey: bookLayoutKey(data),
    }));
    router.push("/cover");
  };

  const openOrder = () => {
    if (!canPrint || !data || !submissionPageCountValid) return;
    sessionStorage.setItem(COVER_PAGE_COUNT_SESSION_KEY, JSON.stringify({
      bodyPdfPageCount: submissionPageCount,
      worksKey: bookLayoutKey(data),
    }));
    if (process.env.NODE_ENV === "development") {
      try {
        sessionStorage.setItem(FINAL_PRELOADED_WORKS_SESSION_KEY, JSON.stringify(
          works.map(({ id, title, author, text }) => ({ id, title, author, text })),
        ));
      } catch {
        // The local renderer can fall back to its existing Aozora retrieval path if browser storage is unavailable.
      }
    }
    router.push("/order");
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

        <p role="alert">{error}</p>
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
      bodyTypography={bodyTypography}
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
        bodyTypography={bodyTypography}
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
        bodyTypography={bodyTypography}
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
          bodyTypography={bodyTypography}
        />,
      );
    }
  }

  /*
   * 5. 収録作品と出典。CSVに実在する書誌情報だけを掲載し、
   * 長い短編集では読める文字サイズのまま複数ページへ分ける。
   */

  const sourceWorksPerPage = 4;
  const sourcePages = Array.from({ length: Math.ceil(data.works.length / sourceWorksPerPage) }, (_, index) =>
    data.works.slice(index * sourceWorksPerPage, (index + 1) * sourceWorksPerPage),
  );
  sourcePages.forEach((sourceWorks, index) => {
    bodyPages.push(
      <SourcePage
        key={`sources-${index}`}
        works={sourceWorks}
        pageNumber={currentPageNumber + index}
        pageIndex={index}
        pageCount={sourcePages.length}
        bodyTypography={bodyTypography}
      />,
    );
  });

  /* 6. 奥付 */

  const colophonPageNumber = currentPageNumber + sourcePages.length;

  bodyPages.push(
    <ColophonPage
      key="colophon"
      pageNumber={
        colophonPageNumber
      }
      bodyTypography={bodyTypography}
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
  const coverSummaryPalette = {
    red: { background: "#9e2f2f", foreground: "#fff8eb", label: "赤" },
    blue: { background: "#315f8f", foreground: "#f7f4e9", label: "青" },
    green: { background: "#47704e", foreground: "#f7f4e9", label: "緑" },
  }[data.coverColor];

  /* =======================================================
     表示
  ======================================================= */

  return (
    <>
      <main
        className="print-root"
        data-final-layout-ready={canPrint ? "true" : "false"}
        data-submission-page-count={submissionPageCount}
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
        <section className="print-controls mb-6 w-full max-w-3xl rounded-xl bg-white p-4 text-stone-800 shadow sm:p-6" aria-label="本の完成確認と操作">
          <CreationProgress currentStep={3} />
          <h1 className="text-2xl font-bold">本の完成を確認</h1>
          <p className="mt-2 text-sm text-stone-600">作品の順番・表紙・ページ数を確認して、注文へ進めます。価格は入稿ファイルの検証後にサーバーで確定します。</p>
          {canPrint && (
            <section className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-4" aria-label="完成した本の内容">
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <h2 className="break-words text-xl font-bold">{data.title}</h2>
                  <p className="mt-1 break-words text-sm text-stone-600">編者：{data.editor}</p>
                  <div className="mt-4 rounded-lg bg-white p-3 text-sm">
                    <p className="text-stone-500">仕上がりページ数</p>
                    <p className="mt-1 text-lg font-bold">{submissionPageCount}ページ</p>
                    <p className="mt-1 text-xs leading-5 text-stone-500">目次や作品タイトルなどを含む、実際の組版結果です。</p>
                  </div>
                </div>
                  <div className="flex min-w-0 items-center gap-3 rounded-lg bg-white p-3 sm:w-64 sm:flex-col sm:items-start">
                  <CoverFrontPreview
                    title={data.title}
                    editor={data.editor}
                    coverStyle={data.coverStyle}
                    coverColor={data.coverColor}
                    pageCount={submissionPageCount}
                    className="w-16 shrink-0 sm:w-[5.5rem]"
                  />
                  <div className="min-w-0">
                    <h3 className="font-semibold">表紙</h3>
                    <p className="mt-1 break-words text-sm text-stone-600">{data.coverStyle === "classic" ? "基本デザイン" : "自由デザイン"}・{coverSummaryPalette.label}</p>
                    <button className="mt-2 min-h-10 break-words text-left text-sm font-medium text-emerald-900 underline underline-offset-4" type="button" onClick={openSpreadCover} disabled={!submissionPageCountValid}>
                      表紙を確認・変更
                    </button>
                  </div>
                </div>
              </div>
              <div className="mt-4 border-t border-stone-200 pt-3">
                <h3 className="font-semibold">収録作品（この順番）</h3>
                <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm text-stone-700">
                  {data.works.map((work, index) => (
                    <li className="break-words" key={`${work.id}-${index}`}>
                      <span className="mr-1 text-stone-500">{index + 1}.</span>{work.title} — {work.author || "作者情報なし"}
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          )}
          {canPrint && (
            <div className="mt-4">
              <button className="min-h-14 w-full break-words rounded-xl bg-emerald-900 px-5 py-4 text-lg font-bold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50" type="button" onClick={openOrder} disabled={!submissionPageCountValid}>
                注文内容を確認して進む
              </button>
              <p className="mt-2 text-xs text-stone-500">この段階では決済されません。ファイル検証・価格確認の後に決済へ進みます。</p>
            </div>
          )}
          {works.some((work) => work.error) && (
            <div role="alert" className="print-errors mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
              <p>作品の本文を読み込めませんでした。全作品を読み込むまで、注文へ進めません。</p>
              <ul>
                {works.filter((work) => work.error).map((work) => (
                  <li key={work.id}><strong>{work.title}</strong>：読み込みに失敗しました。</li>
                ))}
              </ul>
              <button className="mt-3 rounded bg-stone-800 px-4 py-2 text-white disabled:opacity-50" type="button" onClick={retryFailedWorks} disabled={loading}>
                {loading ? "再取得中…" : "作品本文を再取得"}
              </button>
            </div>
          )}
          {canPrint && <p className="mt-5 rounded-lg bg-stone-50 p-3 text-sm text-stone-600">印刷用データはブラウザーへ渡しません。ご注文後に製造用データを生成し、管理された保管先へ保存します。</p>}
          {canPrint && !submissionPageCountValid && (
            <p role="alert" className="mt-4 text-red-800">
              現在のページ数では製本用データを準備できません。作品を追加・削除してページ数を調整してください。
            </p>
          )}
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
