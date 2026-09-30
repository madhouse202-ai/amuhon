"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BookData,
  loadBookData,
} from "@/lib/book";

type WorkText = {
  loading: boolean;
  text: string;
  error: string;
};

const PAGE_WIDTH = 620;
const PAGE_HEIGHT = 700;

const PAGE_PADDING_TOP = 55;
const PAGE_PADDING_BOTTOM = 55;
const PAGE_PADDING_LEFT = 45;
const PAGE_PADDING_RIGHT = 45;

const FONT_SIZE = 18;
const LINE_HEIGHT = 2.1;
const LETTER_SPACING = "0.03em";

/*
 * 1ページに入れる文字数の目安。
 *
 * 今回はまず「ページの中に文字を収める」ことを
 * 優先した仮の値。
 *
 * 後で
 * ・1行の文字数
 * ・1ページの行数
 * ・文字サイズ
 * ・行間
 * ・余白
 * から自動計算するようにする。
 */
const CHARS_PER_PAGE = 520;

function splitTextIntoPages(text: string) {
  const pages: string[] = [];

  let remaining = text.trim();

  while (remaining.length > 0) {
    /*
     * まずページ上限まで切る
     */
    let cut = Math.min(
      CHARS_PER_PAGE,
      remaining.length
    );

    /*
     * できるだけ段落や文章の途中で
     * 不自然に切れないようにする。
     */
    if (cut < remaining.length) {
      const searchStart = Math.max(0, cut - 100);
      const section = remaining.slice(
        searchStart,
        cut
      );

      const breakPositions = [
        section.lastIndexOf("\n"),
        section.lastIndexOf("。"),
        section.lastIndexOf("」"),
        section.lastIndexOf("』"),
        section.lastIndexOf("？"),
        section.lastIndexOf("！"),
      ];

      const bestBreak = Math.max(
        ...breakPositions
      );

      if (bestBreak >= 20) {
        cut =
          searchStart +
          bestBreak +
          1;
      }
    }

    pages.push(
      remaining.slice(0, cut)
    );

    remaining = remaining.slice(cut);
  }

  return pages;
}

export default function FinalPage() {
  const [book, setBook] =
    useState<BookData | null>(null);

  const [texts, setTexts] = useState<
    Record<string, WorkText>
  >({});

  useEffect(() => {
    const data = loadBookData();

    setBook(data);

    if (data.works.length === 0) {
      return;
    }

    const initialTexts: Record<
      string,
      WorkText
    > = {};

    data.works.forEach((work, index) => {
      const key = `${work.id}-${index}`;

      initialTexts[key] = {
        loading: true,
        text: "",
        error: "",
      };
    });

    setTexts(initialTexts);

    data.works.forEach(
      async (work, index) => {
        const key = `${work.id}-${index}`;

        try {
          if (!work.xhtmlUrl) {
            throw new Error(
              "本文URLが登録されていません。"
            );
          }

          const response = await fetch(
            `/api/aozora?url=${encodeURIComponent(
              work.xhtmlUrl
            )}`
          );

          const result =
            await response.json();

          if (!response.ok) {
            throw new Error(
              result.error ??
                "本文の取得に失敗しました。"
            );
          }

          setTexts((current) => ({
            ...current,
            [key]: {
              loading: false,
              text:
                result.text ?? "",
              error: "",
            },
          }));
        } catch (error) {
          setTexts((current) => ({
            ...current,
            [key]: {
              loading: false,
              text: "",
              error:
                error instanceof Error
                  ? error.message
                  : "本文の取得に失敗しました。",
            },
          }));
        }
      }
    );
  }, []);

  if (!book) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#e9e4d9",
          color: "#555",
        }}
      >
        <p>
          本を読み込んでいます……
        </p>
      </main>
    );
  }

  const coverColors = {
    red: {
      background: "#8b2f2f",
      text: "#f8f1df",
    },
    blue: {
      background: "#294765",
      text: "#f4f1e8",
    },
    green: {
      background: "#405943",
      text: "#f3f0df",
    },
  };

  const cover =
    coverColors[book.coverColor];

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#e9e4d9",
        padding: "60px 20px 100px",
        color: "#302d29",
      }}
    >
      {/* =========================
          表紙
      ========================= */}
      <section
        style={{
          width: "min(420px, 90vw)",
          aspectRatio: "0.68",
          margin: "0 auto 100px",
          background: cover.background,
          color: cover.text,
          boxShadow:
            "0 12px 35px rgba(0,0,0,0.18)",
          padding: "60px 45px",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        <p
          style={{
            fontSize: "13px",
            letterSpacing: "0.3em",
            margin: 0,
            opacity: 0.8,
            textAlign: "center",
          }}
        >
          編む本
        </p>

        <div
          style={{
            position: "absolute",
            top: "120px",
            left: "50%",
            transform:
              "translateX(-50%)",
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            height: "250px",
            fontFamily: "serif",
          }}
        >
          <h1
            style={{
              fontSize: "36px",
              fontWeight: "normal",
              lineHeight: "1.6",
              margin: 0,
            }}
          >
            {book.title}
          </h1>
        </div>

        <p
          style={{
            position: "absolute",
            bottom: "55px",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: "14px",
            margin: 0,
            letterSpacing: "0.12em",
          }}
        >
          編者　{book.editor}
        </p>
      </section>

      {/* =========================
          扉
      ========================= */}
      <section
        style={{
          width: "min(620px, 92vw)",
          height: "700px",
          margin: "0 auto 100px",
          background: "#faf8f1",
          boxShadow:
            "0 8px 25px rgba(0,0,0,0.08)",
          boxSizing: "border-box",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "150px",
            left: "50%",
            transform:
              "translateX(-50%)",
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            height: "280px",
            fontFamily: "serif",
          }}
        >
          <h2
            style={{
              fontSize: "36px",
              fontWeight: "normal",
              lineHeight: "1.8",
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            {book.title}
          </h2>
        </div>

        <div
          style={{
            position: "absolute",
            top: "465px",
            left: "50%",
            transform:
              "translateX(-50%)",
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            height: "130px",
            fontFamily: "serif",
          }}
        >
          <p
            style={{
              fontSize: "16px",
              color: "#666",
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            編者　{book.editor}
          </p>
        </div>
      </section>

      {/* =========================
          目次
      ========================= */}
      <section
        style={{
          width: "min(620px, 92vw)",
          minHeight: "700px",
          margin: "0 auto 100px",
          background: "#faf8f1",
          boxShadow:
            "0 8px 25px rgba(0,0,0,0.08)",
          padding: "80px 60px",
          boxSizing: "border-box",
          overflowX: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row-reverse",
            alignItems: "flex-start",
            justifyContent:
              "flex-start",
            gap: "55px",
            minHeight: "520px",
          }}
        >
          <div
            style={{
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              fontFamily: "serif",
              flexShrink: 0,
            }}
          >
            <h2
              style={{
                fontSize: "28px",
                fontWeight: "normal",
                lineHeight: "1.8",
                margin: 0,
                whiteSpace: "nowrap",
              }}
            >
              目次
            </h2>
          </div>

          {book.works.map(
            (work, index) => (
              <div
                key={`${work.id}-${index}`}
                style={{
                  writingMode:
                    "vertical-rl",
                  textOrientation:
                    "mixed",
                  fontFamily: "serif",
                  height: "500px",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontSize: "18px",
                    lineHeight: "1.8",
                    whiteSpace:
                      "nowrap",
                  }}
                >
                  {work.title}
                </span>

                <span
                  style={{
                    display: "block",
                    marginTop: "30px",
                    fontSize: "13px",
                    color: "#888",
                    whiteSpace:
                      "nowrap",
                  }}
                >
                  {work.author}
                </span>
              </div>
            )
          )}
        </div>
      </section>

      {/* =========================
          各作品
      ========================= */}
      {book.works.map(
        (work, index) => {
          const key =
            `${work.id}-${index}`;

          const workText =
            texts[key];

          if (!workText) {
            return null;
          }

          const pages =
            workText.text
              ? splitTextIntoPages(
                  workText.text
                )
              : [];

          return (
            <section
              key={key}
              style={{
                width: "100%",
                margin:
                  "0 auto 100px",
              }}
            >
              {/* =====================
                  作品扉
              ===================== */}
              <div
                style={{
                  width:
                    "min(620px, 92vw)",
                  height: "700px",
                  margin:
                    "0 auto 40px",
                  background:
                    "#faf8f1",
                  boxShadow:
                    "0 8px 25px rgba(0,0,0,0.08)",
                  boxSizing:
                    "border-box",
                  position:
                    "relative",
                }}
              >
                <div
                  style={{
                    position:
                      "absolute",
                    top: "150px",
                    left: "50%",
                    transform:
                      "translateX(-50%)",
                    writingMode:
                      "vertical-rl",
                    textOrientation:
                      "mixed",
                    height: "300px",
                    fontFamily:
                      "serif",
                  }}
                >
                  <h2
                    style={{
                      fontSize: "30px",
                      fontWeight:
                        "normal",
                      lineHeight:
                        "1.8",
                      margin: 0,
                      whiteSpace:
                        "nowrap",
                    }}
                  >
                    {work.title}
                  </h2>
                </div>

                <div
                  style={{
                    position:
                      "absolute",
                    bottom: "120px",
                    left: "50%",
                    transform:
                      "translateX(-50%)",
                    writingMode:
                      "vertical-rl",
                    textOrientation:
                      "mixed",
                    height: "100px",
                    fontFamily:
                      "serif",
                  }}
                >
                  <p
                    style={{
                      margin: 0,
                      color: "#777",
                      fontSize: "14px",
                      whiteSpace:
                        "nowrap",
                    }}
                  >
                    {work.author}
                  </p>
                </div>
              </div>

              {/* =====================
                  読み込み中
              ===================== */}
              {workText.loading && (
                <p
                  style={{
                    textAlign:
                      "center",
                    color: "#777",
                  }}
                >
                  本文を読み込んでいます……
                </p>
              )}

              {/* =====================
                  エラー
              ===================== */}
              {workText.error && (
                <div
                  style={{
                    width:
                      "min(620px, 92vw)",
                    margin:
                      "0 auto",
                    padding: "20px",
                    background:
                      "#fff4f4",
                    border:
                      "1px solid #e5bcbc",
                    color: "#a33",
                    boxSizing:
                      "border-box",
                  }}
                >
                  <p>
                    本文を取得できませんでした。
                  </p>

                  <p
                    style={{
                      fontSize:
                        "13px",
                      marginTop:
                        "8px",
                    }}
                  >
                    {workText.error}
                  </p>
                </div>
              )}

              {/* =====================
                  本文ページ
              ===================== */}
              {!workText.loading &&
                !workText.error &&
                pages.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection:
                        "row-reverse",
                      gap: "40px",
                      overflowX:
                        "auto",
                      padding:
                        "0 20px 30px",
                      boxSizing:
                        "border-box",
                      alignItems:
                        "flex-start",
                    }}
                  >
                    {pages.map(
                      (
                        pageText,
                        pageIndex
                      ) => (
                        <article
                          key={
                            pageIndex
                          }
                          style={{
                            width:
                              `min(${PAGE_WIDTH}px, 92vw)`,
                            minWidth:
                              `min(${PAGE_WIDTH}px, 92vw)`,
                            height:
                              `${PAGE_HEIGHT}px`,
                            background:
                              "#faf8f1",
                            boxShadow:
                              "0 8px 25px rgba(0,0,0,0.08)",
                            boxSizing:
                              "border-box",
                            paddingTop:
                              `${PAGE_PADDING_TOP}px`,
                            paddingBottom:
                              `${PAGE_PADDING_BOTTOM}px`,
                            paddingLeft:
                              `${PAGE_PADDING_LEFT}px`,
                            paddingRight:
                              `${PAGE_PADDING_RIGHT}px`,
                            position:
                              "relative",
                            flexShrink:
                              0,
                          }}
                        >
                          {/* 本文 */}
                          <div
                            style={{
                              width: "100%",
                              height:
                                `${PAGE_HEIGHT -
                                  PAGE_PADDING_TOP -
                                  PAGE_PADDING_BOTTOM}px`,
                              boxSizing:
                                "border-box",
                              writingMode:
                                "vertical-rl",
                              textOrientation:
                                "mixed",
                              fontFamily:
                                "serif",
                              fontSize:
                                `${FONT_SIZE}px`,
                              lineHeight:
                                LINE_HEIGHT,
                              letterSpacing:
                                LETTER_SPACING,
                              whiteSpace:
                                "pre-wrap",
                              overflow:
                                "hidden",
                            }}
                          >
                            {pageText}
                          </div>

                          {/* ページ番号 */}
                          <div
                            style={{
                              position:
                                "absolute",
                              bottom:
                                "18px",
                              left: 0,
                              right: 0,
                              textAlign:
                                "center",
                              fontFamily:
                                "serif",
                              fontSize:
                                "12px",
                              color:
                                "#888",
                            }}
                          >
                            {pageIndex +
                              1}
                          </div>
                        </article>
                      )
                    )}
                  </div>
                )}
            </section>
          );
        }
      )}

      {/* =========================
          フッター
      ========================= */}
      <footer
        style={{
          width:
            "min(620px, 92vw)",
          margin:
            "60px auto 0",
          display: "flex",
          justifyContent:
            "space-between",
          gap: "20px",
          flexWrap: "wrap",
          fontSize: "14px",
        }}
      >
        <Link
          href="/cover"
          style={{
            color: "#555",
          }}
        >
          ← 表紙を変更する
        </Link>

        <Link
          href="/book"
          style={{
            color: "#555",
          }}
        >
          本文を読む →
        </Link>
      </footer>
    </main>
  );
}