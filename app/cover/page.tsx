"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CoverStyle,
  CoverColor,
  loadBookData,
  saveBookData,
} from "@/lib/book";

export default function CoverPage() {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [editor, setEditor] = useState("");
  const [coverStyle, setCoverStyle] =
    useState<CoverStyle>("classic");
  const [coverColor, setCoverColor] =
    useState<CoverColor>("red");

  useEffect(() => {
    const book = loadBookData();

    setTitle(book.title);
    setEditor(book.editor);
    setCoverStyle(book.coverStyle);
    setCoverColor(book.coverColor);
  }, []);

  function handleSave() {
    const currentBook = loadBookData();

    saveBookData({
      ...currentBook,
      title: title.trim() || "わたしの本",
      editor: editor.trim() || "編者",
      coverStyle,
      coverColor,
    });

    alert("この表紙で決定しました！");

    router.push("/final");
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