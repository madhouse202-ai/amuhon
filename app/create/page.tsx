"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const works = [
  {
    title: "こころ",
    author: "夏目漱石",
  },
  {
    title: "銀河鉄道の夜",
    author: "宮沢賢治",
  },
  {
    title: "注文の多い料理店",
    author: "宮沢賢治",
  },
];

export default function CreatePage() {
    const router = useRouter();
  const [selectedWorks, setSelectedWorks] = useState<string[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const addWork = (title: string) => {
    if (!selectedWorks.includes(title)) {
      setSelectedWorks([...selectedWorks, title]);
    }
  };
  const removeWork = (title: string) => {
  setSelectedWorks(
    selectedWorks.filter((work) => work !== title)
  );
};
const moveWork = (index: number, direction: "up" | "down") => {
  const newWorks = [...selectedWorks];

  if (direction === "up" && index > 0) {
    [newWorks[index - 1], newWorks[index]] = [
      newWorks[index],
      newWorks[index - 1],
    ];
  }

  if (direction === "down" && index < newWorks.length - 1) {
    [newWorks[index], newWorks[index + 1]] = [
      newWorks[index + 1],
      newWorks[index],
    ];
  }

  setSelectedWorks(newWorks);
};

const handleDrop = (targetIndex: number) => {
  if (draggedIndex === null || draggedIndex === targetIndex) {
    return;
  }

  const newWorks = [...selectedWorks];
  const [draggedWork] = newWorks.splice(draggedIndex, 1);

  newWorks.splice(targetIndex, 0, draggedWork);

  setSelectedWorks(newWorks);
  setDraggedIndex(null);
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

        {/* 作品を選ぶ */}
        <section className="mt-12">
          <h2 className="text-2xl font-bold">
            作品を選びましょう
          </h2>

          <p className="mt-3 text-stone-600">
            読みたい作品を選んで、あなたの本に加えてください。
          </p>

          <div className="mt-8 space-y-4">
            {works.map((work) => {
              const isSelected = selectedWorks.includes(work.title);

              return (
                <div
                  key={work.title}
                  className="flex items-center justify-between rounded-2xl bg-white p-6 shadow-sm"
                >
                  <div>
                    <h3 className="text-xl font-bold">
                      {work.title}
                    </h3>

                    <p className="mt-2 text-stone-500">
                      {work.author}
                    </p>
                  </div>

                  <button
                    onClick={() => addWork(work.title)}
                    disabled={isSelected}
                    className={`rounded-xl px-5 py-3 font-medium transition ${
                      isSelected
                        ? "bg-stone-200 text-stone-500"
                        : "bg-stone-800 text-white hover:bg-stone-700"
                    }`}
                  >
                    {isSelected ? "追加済み" : "＋ 本に加える"}
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
            {selectedWorks.map((title, index) => (
  <li
  key={title}
  draggable={true}
  onDragStart={() => setDraggedIndex(index)}
  onDragOver={(e) => e.preventDefault()}
  onDrop={() => handleDrop(index)}
  className="flex items-center justify-between rounded-xl bg-stone-50 px-5 py-4"
>
    <div>
      <span className="mr-3 text-stone-400">
        {index + 1}.
      </span>
      {title}
    </div>

    <div className="flex gap-2">
      <button
        onClick={() => moveWork(index, "up")}
        disabled={index === 0}
        className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
      >
        ↑
      </button>

            <button
        onClick={() => moveWork(index, "down")}
        disabled={index === selectedWorks.length - 1}
        className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
      >
        ↓
      </button>

      <button
        onClick={() => removeWork(title)}
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

  

        <button
         onClick={() => {
  const params = new URLSearchParams();
  params.set("works", selectedWorks.join(","));
  router.push(`/preview?${params.toString()}`);
}}
          className="mt-8 w-full rounded-xl bg-stone-800 px-6 py-4 text-lg font-medium text-white"
        >
          本を編む
        </button>

      </div>
    </main>
  );
}