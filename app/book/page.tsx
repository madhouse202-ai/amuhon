"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadBookData } from "@/lib/book";
import type { BookData } from "@/lib/book";

export default function BookPage() {
  const router = useRouter();

  const [book, setBook] =
    useState<BookData | null>(null);

  useEffect(() => {
    const savedBook = loadBookData();
    setBook(savedBook);
  }, []);

  if (!book) {
    return (
      <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
        <div className="mx-auto max-w-3xl">
          <p className="text-stone-500">
            本を読み込んでいます…
          </p>
        </div>
      </main>
    );
  }

  if (book.works.length === 0) {
    return (
      <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-3xl font-bold">
            本がありません
          </h1>

          <p className="mt-4 text-stone-600">
            まず作品を選んで、本を編んでください。
          </p>

          <button
            onClick={() =>
              router.push("/create")
            }
            className="mt-8 rounded-xl bg-stone-800 px-6 py-4 font-medium text-white transition hover:bg-stone-700"
          >
            作品を選ぶ
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
      <div className="mx-auto max-w-3xl">

        {/* 本のタイトル */}
        <header className="mb-16 text-center">
          <p className="text-sm tracking-widest text-stone-500">
            編む本
          </p>

          <h1 className="mt-6 text-4xl font-bold">
            {book.title}
          </h1>

          <p className="mt-4 text-stone-500">
            {book.editor}
          </p>
        </header>

        {/* 目次 */}
        <section className="rounded-2xl bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-bold">
            目次
          </h2>

          <ol className="mt-8 divide-y divide-stone-200">
            {book.works.map(
              (work, index) => (
                <li
                  key={work.id}
                  className="py-6"
                >
                  <div className="flex gap-5">
                    <span className="text-stone-400">
                      {index + 1}
                    </span>

                    <div>
                      <h3 className="text-xl font-bold">
                        {work.title}
                      </h3>

                      <p className="mt-2 text-stone-500">
                        {work.author}
                      </p>
                    </div>
                  </div>
                </li>
              )
            )}
          </ol>
        </section>

        {/* 本文 */}
        <div className="mt-16 space-y-20">

          {book.works.map(
            (work, index) => (
              <article
                key={work.id}
                className="rounded-2xl bg-white p-8 shadow-sm"
              >
                <header className="border-b border-stone-200 pb-8">
                  <p className="text-sm tracking-widest text-stone-400">
                    第{index + 1}章
                  </p>

                  <h2 className="mt-4 text-3xl font-bold">
                    {work.title}
                  </h2>

                  <p className="mt-3 text-stone-500">
                    {work.author}
                  </p>
                </header>

                <div className="py-10">
                  <p className="text-center text-stone-400">
                    本文を読み込んでいます。
                  </p>

                  <p className="mt-4 text-center text-sm text-stone-400">
                    次の段階で青空文庫から本文を取得します。
                  </p>
                </div>
              </article>
            )
          )}

        </div>

        {/* 戻る */}
        <button
          onClick={() =>
            router.push("/cover")
          }
          className="mt-12 w-full rounded-xl border border-stone-300 bg-white px-6 py-4 font-medium transition hover:bg-stone-100"
        >
          表紙に戻る
        </button>

      </div>
    </main>
  );
}