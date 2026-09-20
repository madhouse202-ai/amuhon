"use client";

import { useEffect, useState } from "react";
import {
  BookData,
  defaultBookData,
  loadBookData,
} from "@/lib/book";

type PreviewPage =
  | {
      type: "cover";
    }
  | {
      type: "title";
    }
  | {
      type: "toc";
    }
  | {
      type: "work";
      title: string;
      text: string;
    };

const sampleTexts: Record<string, string> = {
  "注文の多い料理店":
    "二人の若い紳士が、すっかりイギリスの兵隊のかたちをして、ぴかぴかする鉄砲をかついで、白熊のような犬を二疋つれて、だいぶ山奥の木立の中へはいって行きました。",
  "走れメロス":
    "メロスは激怒した。必ず、かの邪智暴虐の王を除かなければならぬと決意した。メロスには政治がわからぬ。メロスは、村の牧人である。",
  "銀河鉄道の夜":
    "ではみなさんは、そういうふうに川だと云われたり、乳の流れたあとだと云われたりしていた、このぼんやりと白いものがほんとうは何かご承知ですか。",
};

export default function BookPreviewPage() {
  const [book, setBook] = useState<BookData>(defaultBookData);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    const savedBook = loadBookData();
    setBook(savedBook);
  }, []);

  const pages: PreviewPage[] = [
    {
      type: "cover",
    },
    {
      type: "title",
    },
    {
      type: "toc",
    },
    ...book.works.map((title) => ({
      type: "work" as const,
      title,
      text:
        sampleTexts[title] ||
        "この作品の本文は、ここに表示されます。現在はプレビュー用の仮テキストです。",
    })),
  ];

  const currentPage = pages[pageIndex];

  // 次のページへ進む
  const goNext = () => {
    if (pageIndex < pages.length - 1) {
      setPageIndex(pageIndex + 1);
    }
  };

  // 前のページへ戻る
  const goPrevious = () => {
    if (pageIndex > 0) {
      setPageIndex(pageIndex - 1);
    }
  };

  return (
    <main className="min-h-screen bg-stone-100 text-stone-800">
      {/* ヘッダー */}
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <h1 className="text-2xl font-bold tracking-wide">
            📖 編む本
          </h1>

          <div className="hidden items-center gap-3 text-sm text-stone-400 md:flex">
            <span>① 作品を選ぶ</span>
            <span>→</span>
            <span>② 並べる</span>
            <span>→</span>
            <span>③ 表紙</span>
            <span>→</span>
            <span className="font-bold text-stone-800">
              ④ プレビュー
            </span>
            <span>→</span>
            <span>⑤ 注文する</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-10">
        {/* タイトル */}
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-wide">
            あなたの本ができました。
          </h2>

          <p className="mt-3 text-stone-500">
            ページをめくって、本の内容を確認してください。
          </p>
        </div>

        {/* 本＋ページ送り */}
        <div className="mt-10 flex items-center justify-center gap-6">
          {/* 左側：次のページ */}
          <button
            onClick={goNext}
            disabled={pageIndex === pages.length - 1}
            aria-label="次のページ"
            className="rounded-full border border-stone-300 bg-white px-5 py-4 text-xl shadow-sm transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ←
          </button>

          {/* 本 */}
          <div className="relative">
            <div className="flex h-[680px] w-[480px] items-center justify-center overflow-hidden bg-[#f8f4e8] p-14 shadow-2xl">
              {/* 表紙 */}
              {currentPage.type === "cover" && (
                <div
                  className={`relative flex h-full w-full flex-col items-center justify-center bg-[#f3dfb5] px-12 text-center ${
                    book.coverColor === "red"
                      ? "text-red-800"
                      : book.coverColor === "blue"
                      ? "text-blue-800"
                      : "text-green-800"
                  }`}
                >
                  <div
                    className={`absolute inset-5 border-4 ${
                      book.coverColor === "red"
                        ? "border-red-800"
                        : book.coverColor === "blue"
                        ? "border-blue-800"
                        : "border-green-800"
                    }`}
                  />

                  <div
                    className={`absolute inset-8 border ${
                      book.coverColor === "red"
                        ? "border-red-800"
                        : book.coverColor === "blue"
                        ? "border-blue-800"
                        : "border-green-800"
                    }`}
                  />

                  <h3 className="relative z-10 text-4xl font-bold leading-relaxed">
                    {book.title || "わたしの本"}
                  </h3>

                  <div className="my-8 h-px w-20 bg-current" />

                  <p className="relative z-10 text-sm">
                    編者
                  </p>

                  <p className="relative z-10 mt-2 text-xl font-bold">
                    {book.editor || "編者"}
                  </p>

                  <p className="absolute bottom-10 text-xs">
                    編む本
                  </p>
                </div>
              )}

              {/* 扉 */}
              {currentPage.type === "title" && (
                <div className="relative flex h-full w-full flex-col items-center justify-center text-center">
                  <h3 className="text-4xl font-bold">
                    {book.title || "わたしの本"}
                  </h3>

                  <div className="my-10 h-px w-16 bg-stone-400" />

                  <p className="text-sm text-stone-500">
                    編者
                  </p>

                  <p className="mt-3 text-xl font-bold">
                    {book.editor || "編者"}
                  </p>

                  <p className="absolute bottom-20 text-xs text-stone-400">
                    編む本
                  </p>
                </div>
              )}

              {/* 目次 */}
              {currentPage.type === "toc" && (
                <div className="h-full w-full px-4 py-10">
                  <h3 className="text-center text-3xl font-bold">
                    目　次
                  </h3>

                  <div className="mt-14 space-y-7">
                    {book.works.map((title, index) => (
                      <div
                        key={`${title}-${index}`}
                        className="flex items-end gap-3 border-b border-dotted border-stone-300 pb-2"
                      >
                        <span className="text-sm text-stone-500">
                          {String(index + 1).padStart(2, "0")}
                        </span>

                        <span className="text-lg">
                          {title}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 本文 */}
              {currentPage.type === "work" && (
                <div className="flex h-full w-full flex-col">
                  <div className="text-center">
                    <h3 className="text-2xl font-bold">
                      {currentPage.title}
                    </h3>
                  </div>

                  <div className="mt-8 flex flex-1 justify-center overflow-hidden">
                    <div
                      className="h-full text-base leading-[2.1] tracking-wide"
                      style={{
                        writingMode: "vertical-rl",
                        textOrientation: "mixed",
                      }}
                    >
                      {currentPage.text}
                    </div>
                  </div>

                  <div className="mt-4 text-center text-xs text-stone-400">
                    {pageIndex}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右側：前のページ */}
          <button
            onClick={goPrevious}
            disabled={pageIndex === 0}
            aria-label="前のページ"
            className="rounded-full border border-stone-300 bg-white px-5 py-4 text-xl shadow-sm transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
          >
            →
          </button>
        </div>

        {/* ページ番号 */}
        <div className="mt-6 text-center text-sm text-stone-400">
          {pageIndex + 1} / {pages.length}
        </div>

        {/* 本の情報 */}
        <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h3 className="font-bold">
            この本について
          </h3>

          <div className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-stone-400">
                タイトル
              </p>

              <p className="mt-1 font-bold">
                {book.title}
              </p>
            </div>

            <div>
              <p className="text-stone-400">
                編者
              </p>

              <p className="mt-1 font-bold">
                {book.editor}
              </p>
            </div>

            <div>
              <p className="text-stone-400">
                収録作品
              </p>

              <p className="mt-1 font-bold">
                {book.works.length}作品
              </p>
            </div>

            <div>
              <p className="text-stone-400">
                ページ
              </p>

              <p className="mt-1 font-bold">
                {pages.length}ページ
              </p>
            </div>
          </div>
        </div>

        {/* 注文ボタン */}
        <div className="mt-10 text-center">
          <button
            onClick={() => {
              alert(
                "注文画面は次のステップで作ります！"
              );
            }}
            className="rounded-xl bg-stone-800 px-10 py-4 font-bold text-white shadow-lg transition hover:bg-stone-700"
          >
            この本を注文する　→
          </button>

          <p className="mt-3 text-xs text-stone-400">
            ※ 現在はプレビュー段階です
          </p>
        </div>
      </div>
    </main>
  );
}