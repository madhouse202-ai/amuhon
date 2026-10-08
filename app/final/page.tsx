"use client";

import {
  useEffect,
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

const BODY_FONT_SIZE = "8.5pt";

const CONTENT_WIDTH = "87mm";

/*
 * 本文の縦方向を少し広げる。
 *
 * これまで：
 *   126mm
 *
 * 今回：
 *   132mm
 *
 * 40文字を収めるための高さを確保しつつ、
 * 本文全体をページ上端から少し下げる。
 */
const CONTENT_HEIGHT = "126mm";
const BODY_COLUMN_HEIGHT = "132mm";

const COLUMN_WIDTH = "5.4mm";

/*
 * 本文をページ上端から下げる量。
 *
 * padding-top ではなく、
 * 本文領域そのものを広げて位置を調整する。
 */
const BODY_TOP_OFFSET = "7mm";

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

  return Array.from(text).map(
    (char): LayoutUnit => ({
      type: "text",
      text: char,
    }),
  );
}

/* =========================================================
   1段落を縦列へ分割
========================================================= */

function splitParagraphIntoColumns(
  units: LayoutUnit[],
): LayoutUnit[][] {
  const columns: LayoutUnit[][] = [];

  let current: LayoutUnit[] = [];

  const flush = () => {
    if (current.length > 0) {
      columns.push(current);
      current = [];
    }
  };

  for (const unit of units) {
    const char = unit.text;

    if (!char) {
      continue;
    }

    if (char === "\n") {
      flush();
      continue;
    }

    if (
      current.length >= CHARS_PER_COLUMN
    ) {
      if (
        isLineStartKinsoku(char) &&
        current.length > 1
      ) {
        const last = current.pop();

        flush();

        if (last) {
          current.push(last);
        }

        current.push(unit);

        continue;
      }

      flush();
    }

    if (
      current.length ===
        CHARS_PER_COLUMN - 1 &&
      isLineEndKinsoku(char)
    ) {
      flush();
    }

    current.push(unit);
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
  const columns: LayoutUnit[][] = [];

  const paragraphs = text.split(
    /\r?\n/,
  );

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      continue;
    }

    const units =
      textToLayoutUnits(paragraph);

    const paragraphColumns =
      splitParagraphIntoColumns(units);

    columns.push(...paragraphColumns);
  }

  return columns;
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
  return (
    <div
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background: "#f8f3df",
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
            color: "#555",
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
        overflow: "hidden",
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
          width: CONTENT_WIDTH,
          height: CONTENT_HEIGHT,
          margin: "0 auto",
          padding: "8mm 6mm",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: "8mm",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          fontSize: "8.5pt",
          lineHeight: 1.8,
        }}
      >
        <div
          style={{
            fontSize: "11pt",
            letterSpacing: "0.08em",
            marginLeft: "8mm",
          }}
        >
          目次
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4mm",
          }}
        >
          {works.map(
            (work, index) => (
              <div
                key={work.id}
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "4mm",
                  whiteSpace: "nowrap",
                }}
              >
                <span>
                  {work.title}
                </span>

                <span
                  style={{
                    fontSize: "7.5pt",
                    color: "#555",
                  }}
                >
                  {pageNumbers[index] ??
                    ""}
                </span>
              </div>
            ),
          )}
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
      {/*
       * 本文全体を3mm下げる。
       *
       * padding-top は使わない。
       * padding で高さを消費すると、
       * 40文字目が下端で切れるため。
       */}
      <div
        style={{
          width: CONTENT_WIDTH,

          /*
           * 126mmではなく132mm確保。
           */
          height: BODY_COLUMN_HEIGHT,

          /*
           * ページ上端から3mm下げる。
           */
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

                /*
                 * 132mmの高さをそのまま本文に使う。
                 */
                height: BODY_COLUMN_HEIGHT,

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
                ? column.map(
                    (
                      unit,
                      unitIndex,
                    ) => (
                      <span
                        key={unitIndex}
                      >
                        {
                          unit.text
                        }
                      </span>
                    ),
                  )
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
   印刷用CSS
========================================================= */

function PrintStyles() {
  return (
    <style jsx global>{`
      @media print {
        html,
        body {
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
        }

        body {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        .print-root {
          width: 105mm !important;
          min-height: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
        }

        .print-page {
          width: 105mm !important;
          height: 148mm !important;
          margin: 0 !important;
          box-shadow: none !important;
          break-inside: avoid !important;
          page-break-inside: avoid !important;
          overflow: hidden !important;
        }

        @page {
          size: A6 portrait;
          margin: 0;
        }
      }
    `}</style>
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

  /* =======================================================
     青空文庫本文取得
  ======================================================= */

  useEffect(() => {
    const book = loadBookData();

    setData(book);

    async function loadWorks() {
      try {
        setLoading(true);
        setError("");

        const results: WorkText[] =
          [];

        for (const work of book.works) {
          try {
            const response =
              await fetch(
                `/api/aozora?url=${encodeURIComponent(
                  work.xhtmlUrl,
                )}`,
                {
                  cache: "no-store",
                },
              );

            const result =
              await response.json();

            if (!response.ok) {
              throw new Error(
                result.error ??
                  "本文の取得に失敗しました。",
              );
            }

            results.push({
              id: work.id,
              title: work.title,
              author: work.author,
              text:
                result.text ?? "",
            });
          } catch (
            workError
          ) {
            results.push({
              id: work.id,
              title: work.title,
              author: work.author,
              text: "",
              error:
                workError instanceof
                Error
                  ? workError.message
                  : "本文の取得に失敗しました。",
            });
          }
        }

        setWorks(results);
      } catch (loadError) {
        setError(
          loadError instanceof
            Error
            ? loadError.message
            : "本の読み込みに失敗しました。",
        );
      } finally {
        setLoading(false);
      }
    }

    loadWorks();
  }, []);

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
        本を組版しています……
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
      <PrintStyles />

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
        {bodyPages.map(
          (page, index) => (
            <div
              key={index}
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