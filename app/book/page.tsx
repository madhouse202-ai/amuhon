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

export default function BookPage() {
  const [book, setBook] = useState<BookData | null>(null);

  const [texts, setTexts] = useState<
    Record<string, WorkText>
  >({});

  useEffect(() => {
    const data = loadBookData();

    setBook(data);

    if (data.works.length === 0) {
      return;
    }

    const initialTexts: Record<string, WorkText> = {};

    data.works.forEach((work, index) => {
      const key = `${work.id}-${index}`;

      initialTexts[key] = {
        loading: true,
        text: "",
        error: "",
      };
    });

    setTexts(initialTexts);

    data.works.forEach(async (work, index) => {
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

        const result = await response.json();

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
            text: result.text ?? "",
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
    });
  }, []);

  if (!book) {
    return (
      <main
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          padding: "40px 20px",
        }}
      >
        <p>本を読み込んでいます……</p>
      </main>
    );
  }

  if (book.works.length === 0) {
    return (
      <main
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          padding: "40px 20px",
        }}
      >
        <h1>本を読む</h1>

        <p>
          まだ作品が選ばれていません。
        </p>

        <Link href="/create">
          作品を選ぶ →
        </Link>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: "1200px",
        margin: "0 auto",
        padding: "40px 20px",
      }}
    >
      {/* 本のタイトル */}
      <header
        style={{
          textAlign: "center",
          marginBottom: "80px",
          paddingBottom: "40px",
          borderBottom: "1px solid #ddd",
        }}
      >
        <p
          style={{
            fontSize: "14px",
            color: "#777",
            marginBottom: "20px",
          }}
        >
          編む本
        </p>

        <h1
          style={{
            fontSize: "32px",
            marginBottom: "16px",
          }}
        >
          {book.title}
        </h1>

        <p
          style={{
            color: "#666",
          }}
        >
          編者　{book.editor}
        </p>
      </header>

      {/* 目次 */}
      <section
        style={{
          marginBottom: "80px",
          padding: "30px",
          background: "#f7f7f7",
        }}
      >
        <h2
          style={{
            fontSize: "20px",
            marginBottom: "24px",
          }}
        >
          目次
        </h2>

        <ol
          style={{
            margin: 0,
            paddingLeft: "24px",
          }}
        >
          {book.works.map((work, index) => (
            <li
              key={`${work.id}-toc-${index}`}
              style={{
                marginBottom: "12px",
              }}
            >
              <a
                href={`#work-${index}`}
                style={{
                  color: "#333",
                  textDecoration: "none",
                }}
              >
                {work.title}

                <span
                  style={{
                    marginLeft: "8px",
                    color: "#888",
                    fontSize: "14px",
                  }}
                >
                  {work.author}
                </span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      {/* 本文 */}
      <section>
        {book.works.map((work, index) => {
          const key = `${work.id}-${index}`;

          const workText = texts[key];

          return (
            <article
              key={key}
              id={`work-${index}`}
              style={{
                marginBottom: "100px",
              }}
            >
              {/* 作品タイトル */}
              <header
                style={{
                  marginBottom: "40px",
                  paddingBottom: "20px",
                  borderBottom: "1px solid #ddd",
                }}
              >
                <p
                  style={{
                    fontSize: "14px",
                    color: "#888",
                    marginBottom: "8px",
                  }}
                >
                  第{index + 1}作品
                </p>

                <h2
                  style={{
                    fontSize: "28px",
                    marginBottom: "10px",
                  }}
                >
                  {work.title}
                </h2>

                <p
                  style={{
                    color: "#666",
                  }}
                >
                  {work.author}
                </p>
              </header>

              {/* 本文読み込み中 */}
              {workText?.loading && (
                <p
                  style={{
                    color: "#777",
                  }}
                >
                  本文を読み込んでいます……
                </p>
              )}

              {/* 本文取得エラー */}
              {workText?.error && (
                <div
                  style={{
                    padding: "20px",
                    background: "#fff4f4",
                    border: "1px solid #e5bcbc",
                    color: "#a33",
                  }}
                >
                  <p>
                    本文を取得できませんでした。
                  </p>

                  <p
                    style={{
                      fontSize: "13px",
                      marginTop: "8px",
                    }}
                  >
                    {workText.error}
                  </p>
                </div>
              )}

              {/* 本文 */}
              {workText &&
                !workText.loading &&
                !workText.error && (
                  <div
                    style={{
                      writingMode: "vertical-rl",
                      textOrientation: "mixed",
                      fontFamily: "serif",
                      fontSize: "18px",
                      lineHeight: "2.1",
                      whiteSpace: "pre-wrap",

                      /*
                       * 現時点では画面上で縦書き本文を
                       * 読めるようにするための仮サイズ。
                       *
                       * 後で「本の1ページ」という単位に
                       * 作り替える。
                       */
                      height: "700px",

                      overflowX: "auto",
                      overflowY: "hidden",

                      padding: "20px",

                      border: "1px solid #ddd",
                      background: "#fff",

                      /*
                       * 縦書き本文が画面端まで
                       * 張り付かないようにする。
                       */
                      boxSizing: "border-box",
                    }}
                  >
                    {workText.text}
                  </div>
                )}
            </article>
          );
        })}
      </section>

      {/* 下部ナビゲーション */}
      <footer
        style={{
          marginTop: "80px",
          paddingTop: "30px",
          borderTop: "1px solid #ddd",
          display: "flex",
          justifyContent: "space-between",
          gap: "20px",
          flexWrap: "wrap",
        }}
      >
        <Link href="/cover">
          ← 表紙を変更する
        </Link>

        <Link href="/create">
          作品を追加・編集する
        </Link>
      </footer>
    </main>
  );
}