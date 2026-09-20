"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BookData,
  defaultBookData,
  loadBookData,
  saveBookData,
} from "@/lib/book";

export default function Preview() {
  const searchParams = useSearchParams();

  const [book, setBook] = useState<BookData>(defaultBookData);

  useEffect(() => {
    const worksParam = searchParams.get("works");

    const savedBook = loadBookData();

    if (worksParam) {
      const works = worksParam.split(",");

      const newBook = {
        ...savedBook,
        works,
      };

      setBook(newBook);
      saveBookData(newBook);
    } else {
      setBook(savedBook);
    }
  }, [searchParams]);

  const moveUp = (index: number) => {
    if (index === 0) return;

    const newWorks = [...book.works];

    [newWorks[index - 1], newWorks[index]] = [
      newWorks[index],
      newWorks[index - 1],
    ];

    const newBook = {
      ...book,
      works: newWorks,
    };

    setBook(newBook);
    saveBookData(newBook);
  };

  const moveDown = (index: number) => {
    if (index === book.works.length - 1) return;

    const newWorks = [...book.works];

    [newWorks[index], newWorks[index + 1]] = [
      newWorks[index + 1],
      newWorks[index],
    ];

    const newBook = {
      ...book,
      works: newWorks,
    };

    setBook(newBook);
    saveBookData(newBook);
  };

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-12 text-stone-800">
      <div className="mx-auto max-w-2xl">

        <h1 className="text-3xl font-bold">
          あなたの本
        </h1>

        <p className="mt-3 text-stone-500">
          編んだ作品を確認してください。
        </p>

        <div className="mt-10 rounded-2xl bg-white p-8 shadow-sm">

          {book.works.map((title, index) => (
            <div key={`${title}-${index}`}>

              <div className="flex items-center justify-between gap-4">

                <h2 className="text-2xl font-bold">
                  {title}
                </h2>

                <div className="flex gap-2">

                  <button
                    onClick={() => moveUp(index)}
                    disabled={index === 0}
                    className="rounded-lg border border-stone-200 px-3 py-2 text-sm hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ↑
                  </button>

                  <button
                    onClick={() => moveDown(index)}
                    disabled={index === book.works.length - 1}
                    className="rounded-lg border border-stone-200 px-3 py-2 text-sm hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ↓
                  </button>

                </div>

              </div>

              {index < book.works.length - 1 && (
                <div className="my-8 border-t border-stone-200" />
              )}

            </div>
          ))}

        </div>

        <div className="mt-10 text-center">
          <button
            onClick={() => {
              window.location.href = "/cover";
            }}
            className="rounded-xl bg-stone-800 px-6 py-3 text-white hover:bg-stone-700"
          >
            表紙を作る
          </button>
        </div>

      </div>
    </main>
  );
}