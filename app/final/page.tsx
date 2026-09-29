
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BookData,
  loadBookData,
} from "@/lib/book";

export default function FinalPage() {
  const [book, setBook] = useState<BookData | null>(null);

  useEffect(() => {
    const data = loadBookData();
    setBook(data);
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
        <p>本を読み込んでいます……</p>
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

  const cover = coverColors[book.coverColor];

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#e9e4d9",
        padding: "60px 20px 100px",
        color: "#302d29",
      }}
    >
      {/* 表紙 */}
      <section
        style={{
          width: "min(420px, 90vw)",
          aspectRatio: "0.68",
          margin: "0 auto 100px",
          background: cover.background,
          color: cover.text,
          boxShadow: "0 12px 35px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px 45px",
          boxSizing: "border-box",
          textAlign: "center",
        }}
      >
        <div>
          <p
            style={{
              fontSize: "13px",
              letterSpacing: "0.3em",
              marginBottom: "45px",
              opacity: 0.8,
            }}
          >
            編む本
          </p>

          <h1
            style={{
              fontFamily: "serif",
              fontSize: "36px",
              fontWeight: "normal",
              lineHeight: "1.6",
              margin: "0 auto",
              writingMode: "vertical-rl",
              textOrientation: "mixed",
              height: "250px",
            }}
          >
            {book.title}
          </h1>
        </div>

        <div>
          <p
            style={{
              fontSize: "14px",
              margin: 0,
              letterSpacing: "0.12em",
            }}
          >
            編者　{book.editor}
          </p>
        </div>
      </section>

      {/* 扉 */}
      <section
        style={{
          width: "min(620px, 92vw)",
          height: "700px",
          margin: "0 auto 100px",
          background: "#faf8f1",
          boxShadow: "0 8px 25px rgba(0,0,0,0.08)",
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            height: "500px",
            display: "flex",
            alignItems: "center",
            fontFamily: "serif",
          }}
        >
          <p
            style={{
              fontSize: "13px",
              letterSpacing: "0.3em",
              margin: 0,
              color: "#888",
            }}
          >
            編む本
          </p>

          <h2
            style={{
              fontSize: "34px",
              fontWeight: "normal",
              margin: "0 50px",
              lineHeight: "1.8",
            }}
          >
            {book.title}
          </h2>

          <p
            style={{
              fontSize: "15px",
              color: "#666",
              margin: 0,
            }}
          >
            編者　{book.editor}
          </p>
        </div>
      </section>

      {/* 目次 */}
      <section
        style={{
          width: "min(620px, 92vw)",
          minHeight: "700px",
          margin: "0 auto",
          background: "#faf8f1",
          boxShadow: "0 8px 25px rgba(0,0,0,0.08)",
          padding: "70px 60px",
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            height: "540px",
            fontFamily: "serif",
            display: "flex",
            alignItems: "flex-start",
          }}
        >
          <h2
            style={{
              fontWeight: "normal",
              fontSize: "26px",
              lineHeight: "1.8",
              margin: "0 60px 0 0",
            }}
          >
            目次
          </h2>

          <div
            style={{
              display: "flex",
              flexDirection: "row",
              gap: "45px",
              height: "100%",
            }}
          >
            {book.works.length === 0 ? (
              <p
                style={{
                  fontSize: "16px",
                  color: "#888",
                  margin: 0,
                }}
              >
                作品が選ばれていません。
              </p>
            ) : (
              book.works.map((work, index) => (
                <div
                  key={`${work.id}-${index}`}
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "17px",
                      lineHeight: "1.8",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {work.title}
                  </span>

                  <span
                    style={{
                      marginTop: "18px",
                      fontSize: "12px",
                      color: "#888",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {work.author}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* 操作 */}
      <footer
        style={{
          width: "min(620px, 92vw)",
          margin: "60px auto 0",
          display: "flex",
          justifyContent: "space-between",
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