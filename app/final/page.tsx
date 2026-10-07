"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  loadBookData,
  type BookData,
} from "@/lib/book";

const CHARS_PER_COLUMN = 40;
const COLUMNS_PER_PAGE = 16;

const PAGE_WIDTH = "105mm";
const PAGE_HEIGHT = "148mm";

const BODY_FONT_SIZE = "8.5pt";

const CONTENT_WIDTH = "87mm";
const CONTENT_HEIGHT = "126mm";
const COLUMN_WIDTH = "5.4mm";

/* =========================================================
   データ型
========================================================= */

type RubyPart = {
  type: "ruby";
  text: string;
  ruby: string;
};

type TextPart = {
  type: "text";
  text: string;
};

type ContentPart = RubyPart | TextPart;

type WorkText = {
  id: string;
  title: string;
  author: string;
  text: string;
  content: ContentPart[];
  error?: string;
};

type LayoutTextUnit = {
  type: "text";
  text: string;
};

type LayoutRubyUnit = {
  type: "ruby";
  text: string;
  ruby: string;
};

type LayoutNewlineUnit = {
  type: "newline";
};

type LayoutUnit =
  | LayoutTextUnit
  | LayoutRubyUnit
  | LayoutNewlineUnit;

/* =========================================================
   縦書き禁則処理
========================================================= */

/*
 * 行頭に来てほしくない文字
 */
const KINSOKU_LINE_START = new Set([
  "、",
  "。",
  "，",
  "．",
  "、",
  "。",
  "」",
  "』",
  "）",
  "］",
  "〕",
  "〉",
  "》",
  "】",
  "』",
  "〙",
  "〗",
  "】",
  "’",
  "”",
  "〕",
  "〉",
  "》",
  "！",
  "？",
  "｣",
]);

/*
 * 行末に来てほしくない文字
 */
const KINSOKU_LINE_END = new Set([
  "「",
  "『",
  "（",
  "［",
  "〔",
  "〈",
  "《",
  "【",
  "〘",
  "〚",
  "“",
  "‘",
]);

function getUnitText(
  unit: LayoutUnit
): string {
  if (unit.type === "newline") {
    return "";
  }

  return unit.text;
}

function getUnitLength(
  unit: LayoutUnit
): number {
  if (unit.type === "newline") {
    return 0;
  }

  return Math.max(1, unit.text.length);
}

function isLineStartKinsoku(
  unit: LayoutUnit
): boolean {
  if (unit.type === "newline") {
    return false;
  }

  const text = getUnitText(unit);

  return (
    text.length > 0 &&
    KINSOKU_LINE_START.has(text[0])
  );
}

function isLineEndKinsoku(
  unit: LayoutUnit
): boolean {
  if (unit.type === "newline") {
    return false;
  }

  const text = getUnitText(unit);

  return (
    text.length > 0 &&
    KINSOKU_LINE_END.has(
      text[text.length - 1]
    )
  );
}

/* =========================================================
   APIの本文データ → 組版用Unit
========================================================= */

function contentToLayoutUnits(
  content: ContentPart[]
): LayoutUnit[] {
  const units: LayoutUnit[] = [];

  for (const part of content) {
    if (part.type === "ruby") {
      /*
       * ルビのベース文字とルビを1つのUnitとして扱う。
       * 表示時には native <ruby> を使う。
       */
      units.push({
        type: "ruby",
        text: part.text,
        ruby: part.ruby,
      });

      continue;
    }

    const text = part.text;

    for (const char of text) {
      if (char === "\n") {
        units.push({
          type: "newline",
        });
      } else {
        units.push({
          type: "text",
          text: char,
        });
      }
    }
  }

  return units;
}

/*
 * content が取れなかった場合のフォールバック
 */
function textToLayoutUnits(
  text: string
): LayoutUnit[] {
  const units: LayoutUnit[] = [];

  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  for (const char of normalized) {
    if (char === "\n") {
      units.push({
        type: "newline",
      });
    } else {
      units.push({
        type: "text",
        text: char,
      });
    }
  }

  return units;
}

/* =========================================================
   1段落 → 縦1列
========================================================= */

function splitParagraphIntoColumns(
  paragraph: LayoutUnit[]
): LayoutUnit[][] {
  const columns: LayoutUnit[][] = [];

  let currentColumn: LayoutUnit[] = [];
  let currentLength = 0;

  for (let i = 0; i < paragraph.length; i += 1) {
    const unit = paragraph[i];

    if (unit.type === "newline") {
      continue;
    }

    const unitLength = getUnitLength(unit);

    /*
     * 通常の文字数上限
     */
    if (
      currentLength + unitLength >
      CHARS_PER_COLUMN
    ) {
      /*
       * 現在の列の最後が
       * 行末禁則文字なら、できるだけ次の列へ送る。
       */
      if (
        currentColumn.length > 0 &&
        isLineEndKinsoku(
          currentColumn[
            currentColumn.length - 1
          ]
        )
      ) {
        const last =
          currentColumn.pop();

        if (last) {
          currentLength -=
            getUnitLength(last);
        }
      }

      if (currentColumn.length > 0) {
        columns.push(currentColumn);
      }

      currentColumn = [];
      currentLength = 0;

      /*
       * 今から入れる文字が行頭禁則なら、
       * 可能なら前の列の最後に残す。
       */
      if (
        isLineStartKinsoku(unit) &&
        columns.length > 0
      ) {
        const previousColumn =
          columns[columns.length - 1];

        if (
          previousColumn.length <
          CHARS_PER_COLUMN
        ) {
          previousColumn.push(unit);
          continue;
        }
      }
    }

    /*
     * 行頭禁則処理
     *
     * すでに現在列がいっぱいに近い場合、
     * 句読点などを次の列の先頭に置かない。
     */
    if (
      currentColumn.length > 0 &&
      currentLength >= CHARS_PER_COLUMN
    ) {
      columns.push(currentColumn);
      currentColumn = [];
      currentLength = 0;
    }

    currentColumn.push(unit);
    currentLength += unitLength;
  }

  if (currentColumn.length > 0) {
    columns.push(currentColumn);
  }

  return columns;
}

/* =========================================================
   全本文 → 縦列
========================================================= */

function splitContentIntoColumns(
  units: LayoutUnit[]
): LayoutUnit[][] {
  const columns: LayoutUnit[][] = [];

  let paragraph: LayoutUnit[] = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      columns.push([]);
      return;
    }

    const paragraphColumns =
      splitParagraphIntoColumns(
        paragraph
      );

    columns.push(
      ...paragraphColumns
    );

    paragraph = [];
  }

  for (const unit of units) {
    if (unit.type === "newline") {
      flushParagraph();
    } else {
      paragraph.push(unit);
    }
  }

  if (paragraph.length > 0) {
    flushParagraph();
  }

  if (columns.length === 0) {
    columns.push([]);
  }

  return columns;
}

/* =========================================================
   列 → ページ
========================================================= */

function splitContentIntoPages(
  units: LayoutUnit[]
): LayoutUnit[][][] {
  const columns =
    splitContentIntoColumns(units);

  const pages: LayoutUnit[][][] = [];

  for (
    let i = 0;
    i < columns.length;
    i += COLUMNS_PER_PAGE
  ) {
    pages.push(
      columns.slice(
        i,
        i + COLUMNS_PER_PAGE
      )
    );
  }

  if (pages.length === 0) {
    pages.push([[]]);
  }

  return pages;
}

/* =========================================================
   表紙
========================================================= */

function CoverPage({
  title,
  editor,
  coverColor,
}: {
  title: string;
  editor: string;
  coverColor: string;
}) {
  const colorMap: Record<
    string,
    string
  > = {
    red: "#8f2f2f",
    blue: "#315b7d",
    green: "#42634b",
  };

  const backgroundColor =
    colorMap[coverColor] ??
    "#8f2f2f";

  return (
    <section
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background: backgroundColor,
        color: "#fff",
        boxSizing: "border-box",
        margin: "0 auto 40px",
        padding: "16mm 12mm",
        display: "flex",
        flexDirection: "column",
        justifyContent:
          "space-between",
        alignItems: "center",
        pageBreakAfter: "always",
        breakAfter: "page",
      }}
    >
      <div
        style={{
          writingMode:
            "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          fontSize: "22pt",
          lineHeight: 1,
          letterSpacing: "0",
          minHeight: "75mm",
          display: "flex",
          alignItems: "center",
        }}
      >
        {title}
      </div>

      <div
        style={{
          writingMode:
            "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          fontSize: "10pt",
          lineHeight: 1,
          letterSpacing: "0",
        }}
      >
        編者　{editor}
      </div>
    </section>
  );
}

/* =========================================================
   共通ページ
========================================================= */

function VerticalPage({
  children,
  pageNumber,
  pageBreakAfter = true,
}: {
  children: ReactNode;
  pageNumber?: number;
  pageBreakAfter?: boolean;
}) {
  return (
    <article
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        boxSizing: "border-box",
        background: "#fff",
        margin: "0 auto 40px",
        padding: "11mm 9mm",
        position: "relative",
        boxShadow:
          "0 2px 10px rgba(0,0,0,0.10)",
        pageBreakAfter:
          pageBreakAfter
            ? "always"
            : "auto",
        breakAfter:
          pageBreakAfter
            ? "page"
            : "auto",
        overflow: "hidden",
      }}
    >
      {children}

      {pageNumber !== undefined && (
        <div
          style={{
            position: "absolute",
            bottom: "5mm",
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: "serif",
            fontSize: "8pt",
            color: "#555",
          }}
        >
          {pageNumber}
        </div>
      )}
    </article>
  );
}

/* =========================================================
   扉
========================================================= */

function TitlePage({
  title,
  author,
}: {
  title: string;
  author?: string;
}) {
  return (
    <VerticalPage>
      <div
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          writingMode:
            "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: "18mm",
        }}
      >
        <div
          style={{
            fontSize: "16pt",
            lineHeight: 1,
            letterSpacing: "0",
          }}
        >
          {title}
        </div>

        {author && (
          <div
            style={{
              fontSize: "9pt",
              lineHeight: 1,
              letterSpacing: "0",
            }}
          >
            {author}
          </div>
        )}
      </div>
    </VerticalPage>
  );
}

/* =========================================================
   目次
========================================================= */

function TableOfContents({
  works,
}: {
  works: BookData["works"];
}) {
  return (
    <VerticalPage>
      <div
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding:
            "8mm 8mm 8mm 10mm",
          writingMode:
            "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          display: "flex",
          gap: "8mm",
          alignItems: "flex-start",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {works.map(
          (work) => (
            <div
              key={work.id}
              style={{
                fontSize: "9pt",
                lineHeight: 1,
                whiteSpace: "nowrap",
                letterSpacing: "0",
              }}
            >
              {work.title}
            </div>
          )
        )}
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
  /*
   * ここを明示的に型付けする。
   *
   * これによって
   *
   * Parameter 'unit' implicitly has an 'any' type
   * Parameter 'unitIndex' implicitly has an 'any' type
   *
   * を防ぐ。
   */
  const paddedColumns: Array<
    LayoutUnit[] | null
  > = [
    ...columns,
    ...Array(
      Math.max(
        0,
        COLUMNS_PER_PAGE -
          columns.length
      )
    ).fill(null),
  ];

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
          flexDirection:
            "row-reverse",
          alignItems: "flex-start",
          justifyContent:
            "flex-start",
          overflow: "hidden",
        }}
      >
        {paddedColumns.map(
          (
            column: LayoutUnit[] | null,
            columnIndex: number
          ) => (
            <div
              key={columnIndex}
              style={{
                width: COLUMN_WIDTH,
                height: CONTENT_HEIGHT,
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
                overflow: "hidden",
                wordBreak: "normal",
                overflowWrap:
                  "normal",
              }}
            >
              {column
                ? column.map(
                    (
                      unit: LayoutUnit,
                      unitIndex: number
                    ) => {
                      /*
                       * 改行
                       */
                      if (
                        unit.type ===
                        "newline"
                      ) {
                        return (
                          <span
                            key={
                              unitIndex
                            }
                          >
                            {"\n"}
                          </span>
                        );
                      }

                      /*
                       * ルビ
                       */
                      if (
                        unit.type ===
                        "ruby"
                      ) {
                        return (
                          <ruby
                            key={
                              unitIndex
                            }
                            style={{
                              rubyPosition:
                                "over",
                            }}
                          >
                            {unit.text}

                            <rt
                              style={{
                                fontSize:
                                  "0.5em",
                                lineHeight: 1,
                              }}
                            >
                              {
                                unit.ruby
                              }
                            </rt>
                          </ruby>
                        );
                      }

                      /*
                       * 通常文字
                       */
                      return (
                        <span
                          key={
                            unitIndex
                          }
                        >
                          {unit.text}
                        </span>
                      );
                    }
                  )
                : null}
            </div>
          )
        )}
      </div>
    </VerticalPage>
  );
}

/* =========================================================
   印刷CSS
========================================================= */

function PrintStyles() {
  return (
    <style>{`
      @page {
        size: A6 portrait;
        margin: 0;
      }

      @media print {
        html,
        body {
          width: 105mm;
          margin: 0;
          padding: 0;
          background: #fff !important;
        }

        body {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .screen-only {
          display: none !important;
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
        }
      }
    `}</style>
  );
}

/* =========================================================
   完成本ページ
========================================================= */

export default function FinalPage() {
  const [book, setBook] =
    useState<BookData | null>(
      null
    );

  const [worksText, setWorksText] =
    useState<WorkText[]>([]);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    const savedBook =
      loadBookData();

    setBook(savedBook);

    async function loadTexts() {
      const results: WorkText[] =
        [];

      for (const work of savedBook.works) {
        try {
          const response =
            await fetch(
              `/api/aozora?url=${encodeURIComponent(
                work.xhtmlUrl
              )}`
            );

          if (!response.ok) {
            throw new Error(
              "本文の取得に失敗しました"
            );
          }

          const data =
            await response.json();

          results.push({
            id: work.id,
            title: work.title,
            author: work.author,
            text:
              data.text ?? "",
            content:
              Array.isArray(
                data.content
              )
                ? data.content
                : [],
          });
        } catch (error) {
          results.push({
            id: work.id,
            title: work.title,
            author: work.author,
            text: "",
            content: [],
            error:
              error instanceof
              Error
                ? error.message
                : "本文の取得に失敗しました",
          });
        }
      }

      setWorksText(results);
      setLoading(false);
    }

    loadTexts();
  }, []);

  function handleCreatePdf() {
    window.print();
  }

  if (loading) {
    return (
      <main
        style={{
          maxWidth: "900px",
          margin: "0 auto",
          padding:
            "60px 20px",
          textAlign: "center",
        }}
      >
        <h1>完成した本</h1>

        <p>
          本文を組版しています……
        </p>
      </main>
    );
  }

  if (!book) {
    return (
      <main
        style={{
          maxWidth: "900px",
          margin: "0 auto",
          padding:
            "60px 20px",
        }}
      >
        <h1>完成した本</h1>

        <p>
          本のデータが見つかりません。
        </p>
      </main>
    );
  }

  /*
   * 本文ページのノンブル。
   *
   * 現在は「本全体の扉」「目次」「作品扉」は
   * ノンブル対象外としている。
   */
  let bodyPageNumber = 1;

  return (
    <>
      <PrintStyles />

      <main
        className="print-root"
        style={{
          background: "#f1f1f1",
          minHeight: "100vh",
          padding:
            "50px 20px 100px",
        }}
      >
        {/* =================================================
            画面上の操作部分
        ================================================= */}

        <div
          className="screen-only"
          style={{
            width: "100%",
            maxWidth: "700px",
            margin:
              "0 auto 40px",
            textAlign: "center",
          }}
        >
          <h1
            style={{
              fontFamily: "serif",
              fontWeight: "normal",
              marginBottom:
                "12px",
            }}
          >
            完成した本
          </h1>

          <p
            style={{
              margin: 0,
              color: "#666",
              fontSize: "14px",
            }}
          >
            A6判　105mm ×
            148mm
            <br />
            {CHARS_PER_COLUMN}
            文字 ×{" "}
            {COLUMNS_PER_PAGE}
            列
            <br />
            1ページあたり{" "}
            {CHARS_PER_COLUMN *
              COLUMNS_PER_PAGE}
            文字
          </p>

          <button
            type="button"
            onClick={
              handleCreatePdf
            }
            style={{
              marginTop: "24px",
              padding:
                "12px 28px",
              border: "none",
              borderRadius: "6px",
              background: "#222",
              color: "#fff",
              fontSize: "15px",
              cursor: "pointer",
            }}
          >
            PDFを作成する
          </button>

          <p
            style={{
              marginTop: "10px",
              fontSize: "12px",
              color: "#777",
            }}
          >
            「PDFを作成する」を押したあと、
            「PDFとして保存」を選択してください。
          </p>
        </div>

        {/* =================================================
            本体
        ================================================= */}

        <div
          style={{
            width: "100%",
          }}
        >
          {/* 表紙 */}
          <CoverPage
            title={book.title}
            editor={book.editor}
            coverColor={
              book.coverColor
            }
          />

          {/* 本全体の扉 */}
          <TitlePage
            title={book.title}
            author={`編者　${book.editor}`}
          />

          {/* 目次 */}
          {book.works.length >
            0 && (
            <TableOfContents
              works={
                book.works
              }
            />
          )}

          {/* =================================================
              各作品
          ================================================= */}

          {worksText.map(
            (work) => {
              /*
               * APIから返ってきたcontentを
               * 優先して使う。
               *
               * contentがない古いデータの場合は
               * textへフォールバック。
               */
              const units =
                work.content.length >
                0
                  ? contentToLayoutUnits(
                      work.content
                    )
                  : textToLayoutUnits(
                      work.text
                    );

              const pages =
                splitContentIntoPages(
                  units
                );

              return (
                <section
                  key={work.id}
                >
                  {/* 作品扉 */}
                  <TitlePage
                    title={
                      work.title
                    }
                    author={
                      work.author
                    }
                  />

                  {/* 本文 */}
                  {work.error ? (
                    <VerticalPage>
                      <div
                        style={{
                          fontFamily:
                            "serif",
                          color:
                            "#a00",
                          writingMode:
                            "vertical-rl",
                        }}
                      >
                        {
                          work.error
                        }
                      </div>
                    </VerticalPage>
                  ) : (
                    pages.map(
                      (
                        pageColumns: LayoutUnit[][],
                        index: number
                      ) => {
                        const currentPageNumber =
                          bodyPageNumber;

                        bodyPageNumber +=
                          1;

                        return (
                          <BodyPage
                            key={`${work.id}-${index}`}
                            columns={
                              pageColumns
                            }
                            pageNumber={
                              currentPageNumber
                            }
                          />
                        );
                      }
                    )
                  )}
                </section>
              );
            }
          )}

          {/* =================================================
              奥付
          ================================================= */}

          <VerticalPage
            pageBreakAfter={false}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                writingMode:
                  "vertical-rl",
                textOrientation:
                  "mixed",
                fontFamily: "serif",
                fontSize: "9pt",
                lineHeight: 1.8,
                letterSpacing: "0",
                display: "flex",
                justifyContent:
                  "center",
                alignItems:
                  "center",
                whiteSpace:
                  "pre-wrap",
              }}
            >
              編む本
              {"\n"}
              {book.title}
              {"\n"}
              編者　{book.editor}
            </div>
          </VerticalPage>
        </div>
      </main>
    </>
  );
}