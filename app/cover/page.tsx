"use client";

import { useState } from "react";

type CoverStyle = "classic" | "free";
type CoverColor = "red" | "blue" | "green";

export default function CoverPage() {
  const [title, setTitle] = useState("わたしの本");
  const [editor, setEditor] = useState("編者");
  const [coverStyle, setCoverStyle] = useState<CoverStyle>("classic");
  const [coverColor, setCoverColor] = useState<CoverColor>("red");

  const colorClasses = {
    red: {
      text: "text-red-800",
      border: "border-red-800",
      bg: "bg-red-800",
    },
    blue: {
      text: "text-blue-800",
      border: "border-blue-800",
      bg: "bg-blue-800",
    },
    green: {
      text: "text-green-800",
      border: "border-green-800",
      bg: "bg-green-800",
    },
  };

  const selectedColor = colorClasses[coverColor];

  return (
    <main className="min-h-screen bg-stone-50 text-stone-800">

      {/* ヘッダー */}
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">

          <h1 className="text-2xl font-bold tracking-wide">
            📖 編む本
          </h1>

          <div className="flex items-center gap-3 text-sm text-stone-400">
            <span>① 作品を選ぶ</span>
            <span>→</span>
            <span>② 並べる</span>
            <span>→</span>
            <span className="font-bold text-stone-800">
              ③ 表紙を作る
            </span>
            <span>→</span>
            <span>④ プレビュー</span>
            <span>→</span>
            <span>⑤ 注文する</span>
          </div>

        </div>
      </header>

      {/* メイン */}
      <div className="mx-auto max-w-6xl px-6 py-12">

        <h2 className="text-4xl font-bold tracking-wide">
          表紙を作りましょう
        </h2>

        <p className="mt-4 leading-8 text-stone-500">
          本のタイトルと編者名を入力し、表紙のデザインを選んでください。
          <br />
          あなたの「編んだ本」が、ここで形になります。
        </p>

        <div className="mt-10 grid gap-8 lg:grid-cols-2">

          {/* 左：設定 */}
          <section className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">

            <h3 className="text-xl font-bold">
              1. タイトルと編者名を入力
            </h3>

            {/* タイトル */}
            <div className="mt-8">
              <label className="text-sm font-bold">
                タイトル
              </label>

              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={50}
                className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none transition focus:border-stone-600"
              />

              <p className="mt-1 text-right text-xs text-stone-400">
                {title.length} / 50
              </p>
            </div>

            {/* 編者 */}
            <div className="mt-5">
              <label className="text-sm font-bold">
                編者名
              </label>

              <input
                type="text"
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
                maxLength={30}
                className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 outline-none transition focus:border-stone-600"
              />

              <p className="mt-1 text-right text-xs text-stone-400">
                {editor.length} / 30
              </p>
            </div>

            <div className="my-8 border-t border-stone-200" />

            {/* デザイン選択 */}
            <h3 className="text-xl font-bold">
              2. 表紙のデザインを選ぶ
            </h3>

            <div className="mt-6 grid grid-cols-2 gap-4">

              {/* 基本 */}
              <button
                onClick={() => setCoverStyle("classic")}
                className={`rounded-xl border-2 p-5 text-left transition ${
                  coverStyle === "classic"
                    ? "border-stone-700 bg-stone-50"
                    : "border-stone-200 hover:border-stone-400"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-5 w-5 rounded-full border-2 ${
                      coverStyle === "classic"
                        ? "border-stone-700"
                        : "border-stone-300"
                    }`}
                  >
                    {coverStyle === "classic" && (
                      <div className="m-1 h-2 w-2 rounded-full bg-stone-700" />
                    )}
                  </div>

                  <span className="font-bold">
                    基本の表紙デザイン
                  </span>
                </div>

                <p className="mt-3 text-sm leading-6 text-stone-500">
                  クラシックで上品な、
                  <br />
                  定番のデザインです。
                </p>
              </button>

              {/* 自由 */}
              <button
                onClick={() => setCoverStyle("free")}
                className={`rounded-xl border-2 p-5 text-left transition ${
                  coverStyle === "free"
                    ? "border-stone-700 bg-stone-50"
                    : "border-stone-200 hover:border-stone-400"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-5 w-5 rounded-full border-2 ${
                      coverStyle === "free"
                        ? "border-stone-700"
                        : "border-stone-300"
                    }`}
                  >
                    {coverStyle === "free" && (
                      <div className="m-1 h-2 w-2 rounded-full bg-stone-700" />
                    )}
                  </div>

                  <span className="font-bold">
                    自由にデザインする
                  </span>
                </div>

                <p className="mt-3 text-sm leading-6 text-stone-500">
                  自分で色や文字、
                  <br />
                  レイアウトを設定できます。
                </p>
              </button>

            </div>

            {/* 基本デザインの色 */}
            {coverStyle === "classic" && (
              <div className="mt-8">

                <h4 className="font-bold">
                  表紙の色
                </h4>

                <div className="mt-4 flex gap-4">

                  <button
                    onClick={() => setCoverColor("red")}
                    aria-label="赤"
                    className={`h-10 w-10 rounded-full bg-red-800 ${
                      coverColor === "red"
                        ? "ring-2 ring-stone-800 ring-offset-2"
                        : ""
                    }`}
                  />

                  <button
                    onClick={() => setCoverColor("blue")}
                    aria-label="青"
                    className={`h-10 w-10 rounded-full bg-blue-800 ${
                      coverColor === "blue"
                        ? "ring-2 ring-stone-800 ring-offset-2"
                        : ""
                    }`}
                  />

                  <button
                    onClick={() => setCoverColor("green")}
                    aria-label="緑"
                    className={`h-10 w-10 rounded-full bg-green-800 ${
                      coverColor === "green"
                        ? "ring-2 ring-stone-800 ring-offset-2"
                        : ""
                    }`}
                  />

                </div>

              </div>
            )}

            {/* 自由デザイン */}
            {coverStyle === "free" && (
              <div className="mt-8 rounded-xl bg-stone-50 p-5">

                <p className="font-bold">
                  自由デザイン
                </p>

                <p className="mt-2 text-sm leading-6 text-stone-500">
                  自由デザイン機能は、これから追加していきます。
                  <br />
                  現在はプレビュー画面でレイアウトを確認できます。
                </p>

              </div>
            )}

            {/* 決定 */}
            <button
              onClick={() => {
                alert("この表紙で決定しました！");
              }}
              className="mt-10 w-full rounded-xl bg-stone-800 px-6 py-4 font-bold text-white transition hover:bg-stone-700"
            >
              この表紙で決定する　→
            </button>

          </section>

          {/* 右：プレビュー */}
          <section className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">

            <h3 className="text-xl font-bold">
              プレビュー
            </h3>

            <div className="mt-8 flex min-h-[650px] items-center justify-center">

              {/* 基本デザイン */}
              {coverStyle === "classic" && (
                <div
                  className={`relative flex h-[520px] w-[360px] flex-col items-center justify-center bg-[#f3dfb5] px-12 text-center shadow-2xl ${selectedColor.text}`}
                >

                  {/* 外枠 */}
                  <div
                    className={`absolute inset-5 border-4 ${selectedColor.border}`}
                  />

                  {/* 内枠 */}
                  <div
                    className={`absolute inset-8 border ${selectedColor.border}`}
                  />

                  {/* 装飾 */}
                  <div className="absolute left-9 top-9 text-3xl">
                    ❧
                  </div>

                  <div className="absolute right-9 top-9 text-3xl">
                    ❧
                  </div>

                  <div className="absolute bottom-9 left-9 rotate-180 text-3xl">
                    ❧
                  </div>

                  <div className="absolute bottom-9 right-9 rotate-180 text-3xl">
                    ❧
                  </div>

                  {/* タイトル */}
                  <h4 className="relative z-10 text-4xl font-bold leading-relaxed">
                    {title || "タイトル"}
                  </h4>

                  <div
                    className={`relative z-10 my-8 h-px w-20 ${selectedColor.bg}`}
                  />

                  {/* 編者 */}
                  <p className="relative z-10 text-sm">
                    編者
                  </p>

                  <p className="relative z-10 mt-2 text-xl font-bold">
                    {editor || "編者名"}
                  </p>

                  <p className="absolute bottom-12 text-xs">
                    編む本
                  </p>

                </div>
              )}

              {/* 自由デザイン */}
              {coverStyle === "free" && (
                <div className="relative flex h-[520px] w-[360px] flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-sky-100 via-stone-50 to-stone-200 px-10 text-center shadow-2xl">

                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.8),transparent_35%),radial-gradient(circle_at_70%_80%,rgba(120,150,160,0.15),transparent_40%)]" />

                  <h4 className="relative text-4xl font-bold leading-relaxed text-stone-800">
                    {title || "タイトル"}
                  </h4>

                  <div className="relative my-8 h-px w-16 bg-stone-700" />

                  <p className="relative text-sm text-stone-600">
                    編者
                  </p>

                  <p className="relative mt-2 text-xl font-bold text-stone-800">
                    {editor || "編者名"}
                  </p>

                </div>
              )}

            </div>

            <p className="text-center text-xs leading-5 text-stone-400">
              ※ これはプレビューです。実際の印刷では、
              <br />
              色味や質感が異なる場合があります。
            </p>

          </section>

        </div>

      </div>
    </main>
  );
}