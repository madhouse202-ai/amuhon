"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Work = {
  id: string;
  title: string;
  author: string;
};

export default function CreatePage() {
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [works, setWorks] = useState<Work[]>([]);
  const [selectedWorks, setSelectedWorks] = useState<Work[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const searchWorks = async () => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setWorks([]);
      setSearched(false);
      return;
    }

    setIsSearching(true);

    try {
      const response = await fetch(
        `/api/works?q=${encodeURIComponent(trimmedQuery)}`
      );

      console.log("API response:", response.status);

      if (!response.ok) {
        throw new Error("作品検索に失敗しました");
      }

      const data = await response.json();

      setWorks(data.works ?? []);
      setSearched(true);
    } catch (error) {
      console.error(error);
      setWorks([]);
      setSearched(true);
    } finally {
      setIsSearching(false);
    }
  };

  const addWork = (work: Work) => {
    const alreadySelected = selectedWorks.some(
      (selected) => selected.id === work.id
    );

    if (!alreadySelected) {
      setSelectedWorks([...selectedWorks, work]);
    }
  };

  const removeWork = (id: string) => {
    setSelectedWorks(
      selectedWorks.filter((work) => work.id !== id)
    );
  };

  const moveWork = (
    index: number,
    direction: "up" | "down"
  ) => {
    const newWorks = [...selectedWorks];

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

    setSelectedWorks(newWorks);
  };

  const handleDrop = (targetIndex: number) => {
    if (
      draggedIndex === null ||
      draggedIndex === targetIndex
    ) {
      return;
    }

    const newWorks = [...selectedWorks];

    const [draggedWork] = newWorks.splice(
      draggedIndex,
      1
    );

    newWorks.splice(targetIndex, 0, draggedWork);

    setSelectedWorks(newWorks);
    setDraggedIndex(null);
  };

  const isSelected = (id: string) => {
    return selectedWorks.some(
      (work) => work.id === id
    );
  };

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
      <div className="mx-auto max-w-3xl">

        <p className="text-sm tracking-widest text-stone-500">
          編む本
        </p>

        <h1 className="mt-4 text-4xl font-bold">
          本を編み始める
        </h1>

        <p className="mt-6 text-lg leading-8 text-stone-600">
          ここから、あなたの一冊をつくっていきます。
        </p>

        {/* 作品を探す */}
        <section className="mt-12">
          <h2 className="text-2xl font-bold">
            作品を探しましょう
          </h2>

          <p className="mt-3 text-stone-600">
            作品名や作者名で検索できます。
          </p>

          <div className="mt-6 flex gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) =>
                setQuery(e.target.value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  searchWorks();
                }
              }}
              placeholder="作品名や作者名を入力"
              className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-5 py-4 outline-none focus:border-stone-500"
            />

            <button
              onClick={searchWorks}
              disabled={isSearching}
              className="rounded-xl bg-stone-800 px-6 py-4 font-medium text-white transition hover:bg-stone-700 disabled:opacity-50"
            >
              {isSearching ? "検索中…" : "検索"}
            </button>
          </div>

          {/* 検索結果 */}
          <div className="mt-8 space-y-4">
            {searched && works.length === 0 && !isSearching && (
              <p className="rounded-xl bg-white p-6 text-center text-stone-500">
                作品が見つかりませんでした。
              </p>
            )}

            {works.map((work) => {
              const selected = isSelected(work.id);

              return (
                <div
                  key={work.id}
                  className="flex items-center justify-between rounded-2xl bg-white p-6 shadow-sm"
                >
                  <div>
                    <h3 className="text-xl font-bold">
                      {work.title}
                    </h3>

                    <p className="mt-2 text-stone-500">
                      {work.author}
                    </p>

                    <p className="mt-1 text-xs text-stone-400">
                      青空文庫
                    </p>
                  </div>

                  <button
                    onClick={() => addWork(work)}
                    disabled={selected}
                    className={`rounded-xl px-5 py-3 font-medium transition ${
                      selected
                        ? "bg-stone-200 text-stone-500"
                        : "bg-stone-800 text-white hover:bg-stone-700"
                    }`}
                  >
                    {selected
                      ? "追加済み"
                      : "＋ 本に加える"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* 選んだ作品 */}
        <section className="mt-16 rounded-2xl bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-bold">
            あなたの本
          </h2>

          {selectedWorks.length === 0 ? (
            <p className="mt-4 text-stone-500">
              まだ作品が選ばれていません。
            </p>
          ) : (
            <ol className="mt-6 space-y-3">
              {selectedWorks.map((work, index) => (
                <li
                  key={work.id}
                  draggable={true}
                  onDragStart={() =>
                    setDraggedIndex(index)
                  }
                  onDragOver={(e) =>
                    e.preventDefault()
                  }
                  onDrop={() =>
                    handleDrop(index)
                  }
                  className="flex items-center justify-between rounded-xl bg-stone-50 px-5 py-4"
                >
                  <div>
                    <span className="mr-3 text-stone-400">
                      {index + 1}.
                    </span>

                    <span className="font-medium">
                      {work.title}
                    </span>

                    <span className="ml-3 text-sm text-stone-500">
                      {work.author}
                    </span>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        moveWork(index, "up")
                      }
                      disabled={index === 0}
                      className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
                    >
                      ↑
                    </button>

                    <button
                      onClick={() =>
                        moveWork(index, "down")
                      }
                      disabled={
                        index ===
                        selectedWorks.length - 1
                      }
                      className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
                    >
                      ↓
                    </button>

                    <button
                      onClick={() =>
                        removeWork(work.id)
                      }
                      className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* 本を編む */}
        <button
          onClick={() => {
            const params = new URLSearchParams();

            params.set(
              "works",
              selectedWorks
                .map((work) => work.title)
                .join(",")
            );

            router.push(
              `/preview?${params.toString()}`
            );
          }}
          disabled={selectedWorks.length === 0}
          className="mt-8 w-full rounded-xl bg-stone-800 px-6 py-4 text-lg font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          本を編む
        </button>

      </div>
    </main>
  );
}