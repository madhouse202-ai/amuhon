"use client";

import { useEffect, useMemo, useState } from "react";
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
      author: string;
      text: string;
      workPage: number;
    };

type LoadedWork = {
  title: string;
  author: string;
  text: string;
};

const CHARACTERS_PER_PAGE = 500;

function splitText(
  text: string,
  pageSize: number
) {
  const pages: string[] = [];

  let current = "";

  const paragraphs =
    text.split(/\n+/);

  for (const paragraph of paragraphs) {
    const cleaned =
      paragraph.trim();

    if (!cleaned) {
      continue;
    }

    if (
      current.length + cleaned.length <=
      pageSize
    ) {
      current +=
        (current ? "\n\n" : "") +
        cleaned;
      continue;
    }

    if (current) {
      pages.push(current);
      current = "";
    }

    let remaining = cleaned;

    while (
      remaining.length > pageSize
    ) {
      pages.push(
        remaining.slice(
          0,
          pageSize
        )
      );

      remaining =
        remaining.slice(pageSize);
    }

    current = remaining;
  }

  if (current) {
    pages.push(current);
  }

  return pages;
}

export default function BookPreviewPage() {
  const [book, setBook] =
    useState<BookData>(
      defaultBookData
    );

  const [works, setWorks] =
    useState<LoadedWork[]>([]);

  const [pageIndex, setPageIndex] =
    useState(0);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState("");

  useEffect(() => {
    const savedBook =
      loadBookData();

    setBook(savedBook);

    if (
      savedBook.works.length === 0
    ) {
      setLoading(false);
      return;
    }

    const loadWorks =
      async () => {
        try {
          setLoading(true);
          setError("");

          const results =
            await Promise.all(
              savedBook.works.map(
                async (title) => {
                  const response =
                    await fetch(
                      `/api/aozora?title=${encodeURIComponent(
                        title
                      )}`
                    );

                  const data =
                    await response.json();

                  if (!response.ok) {
                    throw new Error(
                      data.error ||
                        `${title} の取得に失敗しました。`
                    );
                  }

                  return {
                    title:
                      data.title,
                    author:
                      data.author,
                    text:
                      data.text,
                  };
                }
              )
            );

          setWorks(results);
        } catch (err) {
          console.error(err);

          setError(
            err instanceof Error
              ? err.message
              : "本文の取得に失敗しました。"
          );
        } finally {
          setLoading(false);
        }
      };

    loadWorks();
  }, []);

  const pages =
    useMemo<PreviewPage[]>(() => {
      const result: PreviewPage[] = [
        {
          type: "cover",
        },

        {
          type: "title",
        },

        {
          type: "toc",
        },
      ];

      for (const work of works) {
        const textPages =
          splitText(
            work.text,
            CHARACTERS_PER_PAGE
          );

        textPages.forEach(
          (text, index) => {
            result.push({
              type: "work",
              title: work.title,
              author: work.author,
              text,
              workPage:
                index + 1,
            });
          }
        );
      }

      return result;
    }, [works]);

  const currentPage =
    pages[pageIndex];

  const goNext = () => {
    if (
      pageIndex <
      pages.length - 1
    ) {
      setPageIndex(
        pageIndex + 1
      );
    }
  };

  const goPrevious = () => {
    if (pageIndex > 0) {
      setPageIndex(
        pageIndex - 1
      );
    }
  };

  return (
    <main className="min-h-screen bg-stone-100 text-stone-800">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <h1 className="text-2xl font-bold tracking-wide">
            📖 編む本
          </h1>

          <div className="hidden items-center gap-3 text-sm text-stone-400 md:flex">
            <span>
              ① 作品を選ぶ
            </span>

            <span>→</span>

            <span>
              ② 並べる
            </span>

            <span>→</span>

            <span>
              ③ 表紙
            </span>

            <span>→</span>

            <span className="font-bold text-stone-800">
              ④ プレビュー
            </span>

            <span>→</span>

            <span>
              ⑤ 注文する
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-wide">
            あなたの本ができました。
          </h2>

          <p className="mt-3 text-stone-500">
            ページをめくって、本の内容を確認してください。
          </p>
        </div>

        {loading && (
          <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
            <p className="text-lg font-bold">
              本文を読み込んでいます……
            </p>

            <p className="mt-3 text-sm text-stone-400">
              青空文庫から作品を取得しています。
            </p>
          </div>
        )}

        {error && (
          <div className="mx-auto mt-10 max-w-2xl rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="font-bold text-red-800">
              本文を読み込めませんでした。
            </p>

            <p className="mt-2 text-sm text-red-700">
              {error}
            </p>
          </div>
        )}

        {!loading &&
          !error &&
          works.length > 0 &&
          currentPage && (
            <>
              <div className="mt-10 flex items-center justify-center gap-6">
                {/* 左：次のページ */}
                <button
                  onClick={goNext}
                  disabled={
                    pageIndex ===
                    pages.length - 1
                  }
                  aria-label="次のページ"
                  className="rounded-full border border-stone-300 bg-white px-5 py-4 text-xl shadow-sm transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ←
                </button>

                <div className="relative">
                  <div className="flex h-[680px] w-[480px] items-center justify-center overflow-hidden bg-[#f8f4e8] p-14 shadow-2xl">
                    {currentPage.type ===
                      "cover" && (
                      <div
                        className={`relative flex h-full w-full flex-col items-center justify-center bg-[#f3dfb5] px-12 text-center ${
                          book.coverColor ===
                          "red"
                            ? "text-red-800"
                            : book.coverColor ===
                              "blue"
                            ? "text-blue-800"
                            : "text-green-800"
                        }`}
                      >
                        <div
                          className={`absolute inset-5 border-4 ${
                            book.coverColor ===
                            "red"
                              ? "border-red-800"
                              : book.coverColor ===
                                "blue"
                              ? "border-blue-800"
                              : "border-green-800"
                          }`}
                        />

                        <div
                          className={`absolute inset-8 border ${
                            book.coverColor ===
                            "red"
                              ? "border-red-800"
                              : book.coverColor ===
                                "blue"
                              ? "border-blue-800"
                              : "border-green-800"
                          }`}
                        />

                        <h3 className="relative z-10 text-4xl font-bold leading-relaxed">
                          {book.title ||
                            "わたしの本"}
                        </h3>

                        <div className="my-8 h-px w-20 bg-current" />

                        <p className="relative z-10 text-sm">
                          編者
                        </p>

                        <p className="relative z-10 mt-2 text-xl font-bold">
                          {book.editor ||
                            "編者"}
                        </p>

                        <p className="absolute bottom-10 text-xs">
                          編む本
                        </p>
                      </div>
                    )}

                    {currentPage.type ===
                      "title" && (
                      <div className="relative flex h-full w-full flex-col items-center justify-center text-center">
                        <h3 className="text-4xl font-bold">
                          {book.title ||
                            "わたしの本"}
                        </h3>

                        <div className="my-10 h-px w-16 bg-stone-400" />

                        <p className="text-sm text-stone-500">
                          編者
                        </p>

                        <p className="mt-3 text-xl font-bold">
                          {book.editor ||
                            "編者"}
                        </p>

                        <p className="absolute bottom-20 text-xs text-stone-400">
                          編む本
                        </p>
                      </div>
                    )}

                    {currentPage.type ===
                      "toc" && (
                      <div className="h-full w-full px-4 py-10">
                        <h3 className="text-center text-3xl font-bold">
                          目　次
                        </h3>

                        <div className="mt-14 space-y-7">
                          {works.map(
                            (
                              work,
                              index
                            ) => (
                              <div
                                key={`${work.title}-${index}`}
                                className="flex items-end gap-3 border-b border-dotted border-stone-300 pb-2"
                              >
                                <span className="text-sm text-stone-500">
                                  {String(
                                    index +
                                      1
                                  ).padStart(
                                    2,
                                    "0"
                                  )}
                                </span>

                                <span className="text-lg">
                                  {
                                    work.title
                                  }
                                </span>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    )}

                    {currentPage.type ===
                      "work" && (
                      <div className="flex h-full w-full flex-col">
                        <div className="text-center">
                          <h3 className="text-2xl font-bold">
                            {
                              currentPage.title
                            }
                          </h3>

                          <p className="mt-2 text-xs text-stone-400">
                            {
                              currentPage.author
                            }
                          </p>
                        </div>

                        <div className="mt-6 flex flex-1 justify-center overflow-hidden">
                          <div
                            className="h-full text-base leading-[2.1] tracking-wide"
                            style={{
                              writingMode:
                                "vertical-rl",
                              textOrientation:
                                "mixed",
                              whiteSpace:
                                "pre-wrap",
                            }}
                          >
                            {
                              currentPage.text
                            }
                          </div>
                        </div>

                        <div className="mt-4 text-center text-xs text-stone-400">
                          {currentPage.workPage}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 右：前のページ */}
                <button
                  onClick={
                    goPrevious
                  }
                  disabled={
                    pageIndex === 0
                  }
                  aria-label="前のページ"
                  className="rounded-full border border-stone-300 bg-white px-5 py-4 text-xl shadow-sm transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  →
                </button>
              </div>

              <div className="mt-6 text-center text-sm text-stone-400">
                {pageIndex + 1} /{" "}
                {pages.length}
              </div>

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
                      {works.length}作品
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
            </>
          )}
      </div>
    </main>
  );
}