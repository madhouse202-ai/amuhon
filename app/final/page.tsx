"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  loadBookData,
  type BookData,
} from "@/lib/book";

/* =========================================================
   基本設定
========================================================= */

const CHARS_PER_COLUMN = 40;
const COLUMNS_PER_PAGE = 16;

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

type LayoutUnit = {
  type: "text";
  text: string;
};

function unitCharacterCount(unit: LayoutUnit): number {
  return Array.from(unit.text).length;
}

/* =========================================================
   禁則処理
========================================================= */

function isLineStartKinsoku(char: string) {
  return "、。，．：；？！‼⁇⁈⁉・ヽヾ々ー）］】〕〉》」』〙〗〟’”｣｝〉》".includes(
    char,
  );
}

function isLineEndKinsoku(char: string) {
  return "「『（［【〔〈《〘〖〝‘“".includes(
    char,
  );
}

/* =========================================================
   テキスト → LayoutUnit
========================================================= */

function textToLayoutUnits(
  text: string,
): LayoutUnit[] {
  if (!text) {
    return [];
  }

  return Array.from(text, (char) => ({
    type: "text" as const,
    text: char,
  }));
}

/* =========================================================
   1段落を縦列へ分割
========================================================= */

function splitParagraphIntoColumns(
  units: LayoutUnit[],
): LayoutUnit[][] {
  const columns: LayoutUnit[][] = [];

  let current: LayoutUnit[] = [];
  let currentCharacterCount = 0;

  const flush = () => {
    if (current.length > 0) {
      columns.push(current);
      current = [];
      currentCharacterCount = 0;
    }
  };

  for (const unit of units) {
    const characters = Array.from(unit.text);
    const firstChar = characters[0];
    const lastChar = characters[characters.length - 1];
    const unitLength = unitCharacterCount(unit);

    if (!firstChar) {
      continue;
    }

    if (unit.text === "\n") {
      flush();
      continue;
    }

    if (currentCharacterCount + unitLength > CHARS_PER_COLUMN) {
      if (isLineStartKinsoku(firstChar) && current.length > 0) {
        const last = current.pop();
        if (last) {
          currentCharacterCount -= unitCharacterCount(last);
        }

        flush();

        if (last) {
          current.push(last);
          currentCharacterCount += unitCharacterCount(last);
        }

        current.push(unit);
        currentCharacterCount += unitLength;

        continue;
      }

      flush();
    }

    if (
      currentCharacterCount + unitLength === CHARS_PER_COLUMN &&
      isLineEndKinsoku(lastChar)
    ) {
      flush();
    }

    current.push(unit);
    currentCharacterCount += unitLength;
  }

  flush();

  return columns;
}

/* =========================================================
   本文 → 縦列
========================================================= */

function splitTextIntoColumns(
  text: string,
): LayoutUnit[][] {
  const units: LayoutUnit[] = [];
  const paragraphs = text.split(/\r?\n/).filter((paragraph) => paragraph.trim());

  paragraphs.forEach((paragraph, index) => {
    if (index > 0) {
      // 段落頭は全角1字下げ。同じ列の残りを次段落にも使い、列端の空きを抑える。
      units.push({ type: "text", text: "　" });
    }
    units.push(...textToLayoutUnits(paragraph));
  });

  return splitParagraphIntoColumns(units);
}

/* =========================================================
   本文 → ページ
========================================================= */

function splitTextIntoPages(
  text: string,
): LayoutUnit[][][] {
  const columns =
    splitTextIntoColumns(text);

  const pages: LayoutUnit[][][] = [];

  for (
    let index = 0;
    index < columns.length;
    index += COLUMNS_PER_PAGE
  ) {
    pages.push(
      columns.slice(
        index,
        index + COLUMNS_PER_PAGE,
      ),
    );
  }

  if (pages.length === 0) {
    pages.push([]);
  }

  return pages;
}

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
          style={{
            position: "absolute",
            bottom: "3.5mm",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: "8pt",
            color: "#555",
          }}
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
  pageNumbers,
}: {
  works: WorkText[];
  pageNumbers: number[];
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
          gap: "8mm",
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
            gap: "8mm",
            flexShrink: 0,
          }}
        >
          {works.map((work, index) => (
            <div
              key={work.id}
              style={{
                writingMode: "vertical-rl",
                textOrientation: "upright",
                fontSize: "8.5pt",
                lineHeight: 1.6,
                whiteSpace: "nowrap",
              }}
            >
              <span>{work.title}</span>
              <span
                style={{
                  fontSize: "7.5pt",
                  color: "#a15b46",
                  marginTop: "2mm",
                }}
              >
                {pageNumbers[index] ?? ""}
              </span>
            </div>
          ))}
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
          marginTop: BODY_TOP_OFFSET,
          marginLeft: "auto",
          marginRight: "auto",

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
  const printingRef = useRef(false);

  const loadWorks = async (book: BookData) => {
    setLoading(true);
    setError("");
    setWorks([]);
    setProgress({ completed: 0, total: book.works.length });

    const results: WorkText[] = [];
    for (const work of book.works) {
      try {
        if (!work.xhtmlUrl) {
          throw new Error("本文URLが登録されていません。");
        }
        const response = await fetch(
          `/api/aozora?url=${encodeURIComponent(work.xhtmlUrl)}`,
          { cache: "no-store" },
        );
        const result = await response.json();
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
      setWorks([...results]);
      setProgress({ completed: results.length, total: book.works.length });
    }
    setLoading(false);
  };

  /* =======================================================
     青空文庫本文取得
  ======================================================= */

  useEffect(() => {
    void Promise.resolve().then(() => {
      const book = loadBookData();
      setData(book);
      if (book.works.length === 0) {
        setError("本に作品がありません。作品を選んでからPDFを作成してください。");
        setLoading(false);
        return;
      }
      void loadWorks(book);
    });
  }, []);

  useEffect(() => {
    const resetPrinting = () => {
      printingRef.current = false;
      setIsPrinting(false);
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

  const savePdf = () => {
    if (!canPrint || printingRef.current) return;
    printingRef.current = true;
    setIsPrinting(true);
    window.requestAnimationFrame(() => window.print());
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

  /*
   * 作品開始ページ番号
   *
   * 1 = 本全体タイトル
   * 2 = 目次
   * 3以降 = 各作品タイトル
   */

  const tocPageNumbers: number[] =
    [];

  let currentPageNumber = 3;

  for (const item of workPageData) {
    tocPageNumbers.push(
      currentPageNumber,
    );

    /*
     * 作品タイトルページ
     */
    currentPageNumber += 1;

    /*
     * 本文ページ
     */
    currentPageNumber +=
      item.pages.length;
  }

  /*
   * 3. 目次
   */

  bodyPages.push(
    <TableOfContents
      key="toc"
      works={works}
      pageNumbers={
        tocPageNumbers
      }
    />,
  );

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

  /*
   * 6. 本文部分を偶数ページにする
   */

  const contentPageCount =
    bodyPages.length - 1;

  if (
    contentPageCount % 2 !==
    0
  ) {
    bodyPages.push(
      <VerticalPage
        key="blank-page"
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

  /* =======================================================
     表示
  ======================================================= */

  return (
    <>
      <main
        className="print-root"
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
            <button className="mt-4 rounded bg-stone-800 px-5 py-3 font-bold text-white disabled:opacity-50" type="button" onClick={savePdf} disabled={isPrinting}>
              {isPrinting ? "印刷画面を準備しています…" : "PDFを保存"}
            </button>
          ) : (
            <p>PDFを保存するには、すべての作品本文の取得が必要です。</p>
          )}
          <p>印刷画面で用紙サイズを A6、保存先を「PDFに保存」にしてください。</p>
        </section>

        {bodyPages.map(
          (page, index) => (
            <div
              key={index}
              className="print-sheet"
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
