"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  loadBookData,
  saveBookData,
  type BookData,
} from "@/lib/book";

export default function PreviewPage() {
  const router = useRouter();

  const [book, setBook] = useState<BookData | null>(null);

  useEffect(() => {
    const savedBook = loadBookData();
    setBook(savedBook);
  }, []);

  const moveWork = (
    index: number,
    direction: "up" | "down"
  ) => {
    if (!book) {
      return;
    }

    const newWorks = [...book.works];

    if (direction === "up" && index > 0) {
      [newWorks[index - 1], newWorks[index]] = [
        newWorks[index],
        newWorks[index - 1],
      ];
    }

    if (
      direction === "down" &&
      index < newWorks.length - 1
    ) {
      [newWorks[index], newWorks[index + 1]] = [
        newWorks[index + 1],
        newWorks[index],
      ];
    }

    const newBook = {
      ...book,
      works: newWorks,
    };

    setBook(newBook);
    saveBookData(newBook);
  };

  if (!book) {
    return (
      <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
        <div className="mx-auto max-w-3xl">
          <p className="text-stone-500">
            読み込み中…
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
      <div className="mx-auto max-w-3xl">

        <p className="text-sm tracking-widest text-stone-500">
          編む本
        </p>

        <h1 className="mt-4 text-4xl font-bold">
          あなたの本
        </h1>

        <p className="mt-4 text-lg text-stone-600">
          編んだ作品を確認してください。
        </p>

        {/* 選んだ作品 */}
        <section className="mt-12 rounded-2xl bg-white p-8 shadow-sm">

          {book.works.length === 0 ? (
            <div>
              <p className="text-stone-500">
                まだ作品が選ばれていません。
              </p>

              <button
                onClick={() =>
                  router.push("/create")
                }
                className="mt-6 rounded-xl bg-stone-800 px-6 py-3 font-medium text-white transition hover:bg-stone-700"
              >
                作品を選ぶ
              </button>
            </div>
          ) : (
            <div>
              {book.works.map(
                (work, index) => (
                  <div
                    key={work.id}
                    className="flex items-center justify-between border-b border-stone-200 py-6 last:border-b-0"
                  >
                    <div>
                      <h2 className="text-xl font-bold">
                        {work.title}
                      </h2>

                      <p className="mt-2 text-stone-500">
                        {work.author}
                      </p>
                    </div>

                    <div className="flex gap-2">

                      <button
                        onClick={() =>
                          moveWork(
                            index,
                            "up"
                          )
                        }
                        disabled={
                          index === 0
                        }
                        className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm transition hover:bg-stone-50 disabled:opacity-20"
                      >
                        ↑
                      </button>

                      <button
                        onClick={() =>
                          moveWork(
                            index,
                            "down"
                          )
                        }
                        disabled={
                          index ===
                          book.works.length - 1
                        }
                        className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm transition hover:bg-stone-50 disabled:opacity-20"
                      >
                        ↓
                      </button>

                    </div>
                  </div>
                )
              )}
            </div>
          )}

        </section>

        {/* 表紙を作る */}
        {book.works.length > 0 && (
          <button
            onClick={() =>
              router.push("/cover")
            }
            className="mt-8 w-full rounded-xl bg-stone-800 px-6 py-4 text-lg font-medium text-white transition hover:bg-stone-700"
          >
            表紙を作る
          </button>
        )}

      </div>
    </main>
  );
}