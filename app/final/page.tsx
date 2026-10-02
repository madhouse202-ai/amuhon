"use client";

import { useEffect, useState } from "react";
import { loadBookData, type BookData } from "@/lib/book";

const CHARS_PER_COLUMN = 40;
const COLUMNS_PER_PAGE = 16;

const PAGE_WIDTH = "105mm";
const PAGE_HEIGHT = "148mm";

const BODY_FONT_SIZE = "8.5pt";

const CONTENT_WIDTH = "87mm";
const CONTENT_HEIGHT = "126mm";
const COLUMN_WIDTH = "5.4mm";

type WorkText = {
  id: string;
  title: string;
  author: string;
  text: string;
  error?: string;
};

function splitTextIntoColumns(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const columns: string[] = [];
  const paragraphs = normalized.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      columns.push("");
      continue;
    }

    for (
      let i = 0;
      i < paragraph.length;
      i += CHARS_PER_COLUMN
    ) {
      columns.push(
        paragraph.slice(i, i + CHARS_PER_COLUMN)
      );
    }
  }

  return columns;
}

function splitTextIntoPages(text: string): string[][] {
  const columns = splitTextIntoColumns(text);

  const pages: string[][] = [];

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
    pages.push([""]);
  }

  return pages;
}

function CoverPage({
  title,
  editor,
  coverColor,
}: {
  title: string;
  editor: string;
  coverColor: string;
}) {
  const colorMap: Record<string, string> = {
    red: "#8f2f2f",
    blue: "#315b7d",
    green: "#42634b",
  };

  const backgroundColor =
    colorMap[coverColor] ?? "#8f2f2f";

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
        justifyContent: "space-between",
        alignItems: "center",
        pageBreakAfter: "always",
        breakAfter: "page",
      }}
    >
      <div
        style={{
          writingMode: "vertical-rl",
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
          writingMode: "vertical-rl",
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

function BackCoverPage() {
  return (
    <section
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        boxSizing: "border-box",
        background: "#fff",
        margin: "0 auto 40px",
        padding: "11mm 9mm",
        pageBreakAfter: "auto",
        breakAfter: "auto",
        overflow: "hidden",
      }}
    />
  );
}

function BlankPage() {
  return (
    <section
      className="print-page"
      style={{
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        boxSizing: "border-box",
        background: "#fff",
        margin: "0 auto 40px",
        padding: "11mm 9mm",
        pageBreakAfter: "always",
        breakAfter: "page",
        overflow: "hidden",
      }}
    />
  );
}

function VerticalPage({
  children,
  pageNumber,
  pageBreakAfter = true,
}: {
  children: React.ReactNode;
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
        pageBreakAfter: pageBreakAfter
          ? "always"
          : "auto",
        breakAfter: pageBreakAfter
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
          writingMode: "vertical-rl",
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
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          fontFamily: "serif",
          display: "flex",
          gap: "8mm",
          alignItems: "flex-start",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {works.map((work) => (
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
        ))}
      </div>
    </VerticalPage>
  );
}

function BodyPage({
  columns,
  pageNumber,
}: {
  columns: string[];
  pageNumber: number;
}) {
  const paddedColumns = [
    ...columns,
    ...Array(
      Math.max(
        0,
        COLUMNS_PER_PAGE - columns.length
      )
    ).fill(""),
  ];

  return (
    <VerticalPage pageNumber={pageNumber}>
      <div
        style={{
          width: CONTENT_WIDTH,
          height: CONTENT_HEIGHT,
          margin: "0 auto",
          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          overflow: "hidden",
        }}
      >
        {paddedColumns.map((column, index) => (
          <div
            key={index}
            style={{
              width: COLUMN_WIDTH,
              height: CONTENT_HEIGHT,
              flex: `0 0 ${COLUMN_WIDTH}`,
              boxSizing: "border-box",
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              fontFamily: "serif",
              fontSize: BODY_FONT_SIZE,
              lineHeight: 1,
              letterSpacing: "0",
              whiteSpace: "pre",
              overflow: "hidden",
              wordBreak: "normal",
              overflowWrap: "normal",
            }}
          >
            {column}
          </div>
        ))}
      </div>
    </VerticalPage>
  );
}

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

        .print-page {
          margin: 0 !important;
          box-shadow: none !important;
        }

        .print-root {
          width: 105mm !important;
          min-height: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
        }
      }
    `}</style>
  );
}

export default function FinalPage() {
  const [book, setBook] =
    useState<BookData | null>(null);

  const [worksText, setWorksText] =
    useState<WorkText[]>([]);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    const savedBook = loadBookData();

    setBook(savedBook);

    async function loadTexts() {
      const results: WorkText[] = [];

      for (const work of savedBook.works) {
        try {
          const response = await fetch(
            `/api/aozora?url=${encodeURIComponent(
              work.xhtmlUrl
            )}`
          );

          if (!response.ok) {
            throw new Error(
              "本文の取得に失敗しました"
            );
          }

          const data = await response.json();

          results.push({
            id: work.id,
            title: work.title,
            author: work.author,
            text: data.text ?? "",
          });
        } catch (error) {
          results.push({
            id: work.id,
            title: work.title,
            author: work.author,
            text: "",
            error:
              error instanceof Error
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
          padding: "60px 20px",
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
          padding: "60px 20px",
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
   * 印刷対象本文のページ数を計算する
   *
   * 1. 本全体の扉
   * 2. 目次
   * 3. 各作品の扉
   * 4. 各作品の本文
   * 5. 奥付
   *
   * 表紙と裏表紙は本文ページ数に含めない。
   */
  let printBodyPageCount = 0;

  // 本全体の扉
  printBodyPageCount += 1;

  // 目次
  if (book.works.length > 0) {
    printBodyPageCount += 1;
  }

  // 各作品
  for (const work of worksText) {
    // 作品扉
    printBodyPageCount += 1;

    // 本文
    if (work.error) {
      printBodyPageCount += 1;
    } else {
      printBodyPageCount +=
        splitTextIntoPages(work.text).length;
    }
  }

  // 奥付
  printBodyPageCount += 1;

  /*
   * 無線綴じ本文は偶数ページにする。
   * 奇数の場合は奥付の後ろに白紙を1ページ追加する。
   */
  const needsBlankBodyPage =
    printBodyPageCount % 2 !== 0;

  const finalPrintBodyPageCount =
    printBodyPageCount +
    (needsBlankBodyPage ? 1 : 0);

  /*
   * PDF全体は
   *
   * 表紙 1P
   * ＋本文
   * ＋裏表紙 1P
   *
   * となる。
   */
  const totalPdfPageCount =
    finalPrintBodyPageCount + 2;

  let bodyPageNumber = 1;

  return (
    <>
      <PrintStyles />

      <main
        className="print-root"
        style={{
          background: "#f1f1f1",
          minHeight: "100vh",
          padding: "50px 20px 100px",
        }}
      >
        <div
          className="screen-only"
          style={{
            width: "100%",
            maxWidth: "700px",
            margin: "0 auto 40px",
            textAlign: "center",
          }}
        >
          <h1
            style={{
              fontFamily: "serif",
              fontWeight: "normal",
              marginBottom: "12px",
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
            A6判　105mm × 148mm
            <br />
            {CHARS_PER_COLUMN}文字 ×{" "}
            {COLUMNS_PER_PAGE}列
            <br />
            1ページあたり{" "}
            {CHARS_PER_COLUMN *
              COLUMNS_PER_PAGE}
            文字
          </p>

          <div
            style={{
              marginTop: "24px",
              padding: "16px 20px",
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: "8px",
              fontFamily: "serif",
            }}
          >
            <div
              style={{
                fontSize: "13px",
                color: "#666",
                marginBottom: "6px",
              }}
            >
              印刷対象本文
            </div>

            <div
              style={{
                fontSize: "28px",
                lineHeight: 1.2,
              }}
            >
              {finalPrintBodyPageCount}ページ
            </div>

            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "#777",
              }}
            >
              表紙・裏表紙を除く
            </div>

            {needsBlankBodyPage && (
              <div
                style={{
                  marginTop: "10px",
                  fontSize: "12px",
                  color: "#777",
                }}
              >
                最終ページ調整のため
                白紙1ページを追加します
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: "12px",
              fontSize: "13px",
              color: "#555",
            }}
          >
            PDF全体：{totalPdfPageCount}ページ
            <br />
            表紙1P ＋ 本文
            {finalPrintBodyPageCount}P ＋ 裏表紙1P
          </div>

          <button
            type="button"
            onClick={handleCreatePdf}
            style={{
              marginTop: "24px",
              padding: "12px 28px",
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

        <div
          style={{
            width: "100%",
          }}
        >
          {/* 表紙 */}
          <CoverPage
            title={book.title}
            editor={book.editor}
            coverColor={book.coverColor}
          />

          {/* 本全体の扉 */}
          <TitlePage
            title={book.title}
            author={`編者　${book.editor}`}
          />

          {/* 目次 */}
          {book.works.length > 0 && (
            <TableOfContents
              works={book.works}
            />
          )}

          {/* 各作品 */}
          {worksText.map((work) => {
            const pages =
              splitTextIntoPages(work.text);

            return (
              <section key={work.id}>
                {/* 作品扉 */}
                <TitlePage
                  title={work.title}
                  author={work.author}
                />

                {/* 本文 */}
                {work.error ? (
                  <VerticalPage>
                    <div
                      style={{
                        fontFamily: "serif",
                        color: "#a00",
                        writingMode:
                          "vertical-rl",
                      }}
                    >
                      {work.error}
                    </div>
                  </VerticalPage>
                ) : (
                  pages.map(
                    (pageColumns, index) => {
                      const currentPageNumber =
                        bodyPageNumber;

                      bodyPageNumber += 1;

                      return (
                        <BodyPage
                          key={`${work.id}-${index}`}
                          columns={pageColumns}
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
          })}

          {/* 奥付 */}
          <VerticalPage>
            <div
              style={{
                width: "100%",
                height: "100%",
                writingMode: "vertical-rl",
                textOrientation: "mixed",
                fontFamily: "serif",
                fontSize: "9pt",
                lineHeight: 1.8,
                letterSpacing: "0",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                whiteSpace: "pre-wrap",
              }}
            >
              編む本
              {"\n"}
              {book.title}
              {"\n"}
              編者　{book.editor}
            </div>
          </VerticalPage>

          {/* 本文ページ数調整用の白紙 */}
          {needsBlankBodyPage && (
            <BlankPage />
          )}

          {/* 裏表紙 */}
          <BackCoverPage />
        </div>
      </main>
    </>
  );
}