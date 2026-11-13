"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookWork } from "@/lib/book";
import { CreationProgress } from "@/app/creation-progress";
import { DraftSaveStatus } from "@/app/draft-save-status";
import { useBookDraftAutosave } from "@/lib/use-book-draft-autosave";

type Work = BookWork;
type PageEstimate = { status: "idle" | "loading" | "ready" | "error"; pages?: number };

const pageEstimateCache = new Map<string, number>();
const pageEstimateRequests = new Map<string, Promise<number>>();
let pageEstimateQueue = Promise.resolve();

function getPageEstimate(work: Work): Promise<number> {
  const cached = pageEstimateCache.get(work.xhtmlUrl);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pageEstimateRequests.get(work.xhtmlUrl);
  if (pending) return pending;

  const request = pageEstimateQueue.then(async () => {
    const response = await fetch(
      `/api/aozora?url=${encodeURIComponent(work.xhtmlUrl)}&ruby=1&estimate=1`,
      { cache: "no-store" },
    );
    const result = await response.json();
    if (!response.ok || !Number.isInteger(result.pageCount) || result.pageCount < 1) {
      throw new Error(result.error ?? "ページ数を計算できませんでした。");
    }
    pageEstimateCache.set(work.xhtmlUrl, result.pageCount);
    return result.pageCount as number;
  });
  pageEstimateRequests.set(work.xhtmlUrl, request);
  pageEstimateQueue = request.then(() => undefined, () => undefined);
  void request.then(
    () => pageEstimateRequests.delete(work.xhtmlUrl),
    () => pageEstimateRequests.delete(work.xhtmlUrl),
  );
  return request;
}

function PageEstimateLabel({ estimate, onRetry }: { estimate: PageEstimate; onRetry: () => void }) {
  if (estimate.status === "loading") return <p className="mt-2 text-sm text-stone-500" role="status">ページ数を計算中…</p>;
  if (estimate.status === "ready") return <p className="mt-2 text-sm text-stone-600">本文：約{estimate.pages}ページ</p>;
  if (estimate.status === "error") {
    return <p className="mt-2 text-sm text-amber-800" role="status">ページ数を取得できませんでした。<button type="button" className="ml-2 underline" onClick={onRetry}>再試行</button></p>;
  }
  return <p className="mt-2 text-sm text-stone-400" role="status">ページ数：未計算</p>;
}

function EstimateWhenVisible({
  work,
  estimate,
  onRequest,
  onRetry,
}: {
  work: Work;
  estimate: PageEstimate;
  onRequest: (work: Work) => void;
  onRetry: (work: Work) => void;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (estimate.status !== "idle") return;
    const target = targetRef.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") {
      onRequest(work);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        onRequest(work);
      }
    }, { rootMargin: "160px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [estimate.status, onRequest, work]);

  return (
    <div ref={targetRef}>
      <PageEstimateLabel estimate={estimate} onRetry={() => onRetry(work)} />
    </div>
  );
}

export default function CreatePage() {
  const router = useRouter();
  const { draft, updateDraft, loadState, saveState, flushDraft } = useBookDraftAutosave();

  const [query, setQuery] = useState("");
  const [works, setWorks] = useState<Work[]>([]);
  const selectedWorks = draft.works;
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [pageEstimates, setPageEstimates] = useState<Record<string, PageEstimate>>({});
  const estimatedSelectedIdsRef = useRef(new Set<string>());

  const setSelectedWorks = (next: Work[] | ((current: Work[]) => Work[])) => {
    updateDraft((current) => ({
      ...current,
      works: typeof next === "function" ? next(current.works) : next,
    }));
  };

  const requestEstimate = useCallback((work: Work) => {
    setPageEstimates((current) => {
      const previous = current[work.id];
      if (previous?.status === "loading" || previous?.status === "ready") return current;
      return { ...current, [work.id]: { status: "loading" } };
    });
    void getPageEstimate(work).then(
      (pages) => setPageEstimates((current) => ({ ...current, [work.id]: { status: "ready", pages } })),
      () => setPageEstimates((current) => ({ ...current, [work.id]: { status: "error" } })),
    );
  }, []);

  const retryEstimate = useCallback((work: Work) => {
    setPageEstimates((current) => ({ ...current, [work.id]: { status: "idle" } }));
    requestEstimate(work);
  }, [requestEstimate]);

  useEffect(() => {
    if (loadState !== "ready") return;
    draft.works.forEach((work) => {
      if (estimatedSelectedIdsRef.current.has(work.id)) return;
      estimatedSelectedIdsRef.current.add(work.id);
      requestEstimate(work);
    });
  }, [draft.works, loadState, requestEstimate]);

  const searchWorks = async () => {
    const trimmedQuery = query.trim();
    setSearchError("");

    if (!trimmedQuery) {
      setWorks([]);
      setSearched(false);
      return;
    }

    setIsSearching(true);
    setWorks([]);
    setSearched(false);

    try {
      const response = await fetch(
        `/api/works?q=${encodeURIComponent(trimmedQuery)}`
      );

      if (!response.ok) {
        throw new Error("作品検索に失敗しました");
      }

      const data = await response.json();

      setWorks(data.works ?? []);
      setSearched(true);
    } catch {
      setWorks([]);
      setSearchError("作品を検索できませんでした。通信状態を確認して、もう一度お試しください。");
    } finally {
      setIsSearching(false);
    }
  };

  const addWork = (work: Work) => {
    const alreadySelected = selectedWorks.some(
      (selected) => selected.id === work.id
    );

    if (!alreadySelected) {
      setSelectedWorks([
        ...selectedWorks,
        work,
      ]);
    }
  };

  const removeWork = (id: string) => {
    setSelectedWorks(
      selectedWorks.filter(
        (work) => work.id !== id
      )
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

    newWorks.splice(
      targetIndex,
      0,
      draggedWork
    );

    setSelectedWorks(newWorks);
    setDraggedIndex(null);
  };

  const isSelected = (id: string) => {
    return selectedWorks.some(
      (work) => work.id === id
    );
  };

  const createBook = () => {
    if (selectedWorks.length === 0 || loadState !== "ready") {
      return;
    }

    if (!flushDraft({ ...draft, works: selectedWorks })) return;
    router.push("/cover");
  };

  return (
    <main className="min-h-screen bg-stone-50 px-6 py-16 text-stone-800">
      <div className="mx-auto max-w-3xl">

        <CreationProgress currentStep={1} />
        <div className="mb-5">
          <DraftSaveStatus loadState={loadState} saveState={saveState} onRetry={() => flushDraft()} />
        </div>

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
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchError("");
              }}
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
              {isSearching
                ? "検索中…"
                : "検索"}
            </button>
          </div>

          {/* 検索結果 */}
          <div className="mt-8 space-y-4">

            {searchError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900" role="alert">
                <p>{searchError}</p>
                <button
                  type="button"
                  onClick={() => void searchWorks()}
                  disabled={isSearching || !query.trim()}
                  className="mt-3 rounded-lg border border-red-300 px-4 py-2 font-medium disabled:opacity-50"
                >
                  {isSearching ? "検索中…" : "もう一度検索する"}
                </button>
              </div>
            )}

            {searched &&
              works.length === 0 &&
              !isSearching && !searchError && (
                <p className="rounded-xl bg-white p-6 text-center text-stone-500">
                  作品が見つかりませんでした。
                </p>
              )}

            {works.map((work) => {
              const selected = isSelected(
                work.id
              );

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
                    <EstimateWhenVisible
                      work={work}
                      estimate={pageEstimates[work.id] ?? { status: "idle" }}
                      onRequest={requestEstimate}
                      onRetry={retryEstimate}
                    />
                  </div>

                  <button
                    onClick={() =>
                      addWork(work)
                    }
                    disabled={selected || loadState !== "ready"}
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

              {selectedWorks.map(
                (work, index) => (
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
                      <span className="ml-3 text-sm text-stone-500">
                        {pageEstimates[work.id]?.status === "ready"
                          ? `本文：約${pageEstimates[work.id].pages}ページ`
                          : pageEstimates[work.id]?.status === "error"
                            ? "ページ数：取得失敗"
                            : pageEstimates[work.id]?.status === "loading"
                              ? "ページ数：計算中"
                              : "ページ数：未計算"}
                      </span>
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
                          index === 0 || loadState !== "ready"
                        }
                        className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
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
                          selectedWorks.length - 1 || loadState !== "ready"
                        }
                        className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm disabled:opacity-30"
                      >
                        ↓
                      </button>

                      <button
                        onClick={() =>
                          removeWork(
                            work.id
                          )
                        }
                        disabled={loadState !== "ready"}
                        className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm"
                      >
                        削除
                      </button>

                    </div>
                  </li>
                )
              )}

            </ol>
          )}
          {selectedWorks.length > 0 && (() => {
            const estimates = selectedWorks.map((work) => pageEstimates[work.id]);
            const complete = estimates.every((estimate) => estimate?.status === "ready");
            const unresolved = estimates.filter((estimate) => estimate?.status !== "ready").length;
            const total = estimates.reduce((sum, estimate) => sum + (estimate?.pages ?? 0), 0);
            return complete
              ? <p className="mt-5 font-medium text-stone-700" role="status">選択作品の推定本文合計：約{total}ページ</p>
              : <p className="mt-5 text-sm text-stone-500" role="status">選択作品の推定本文合計：未確定（{unresolved}作品のページ数が未計算または取得失敗）</p>;
          })()}
        </section>

        {/* 本を編む */}
        <button
          onClick={createBook}
          disabled={
            selectedWorks.length === 0 || loadState !== "ready"
          }
          className="mt-8 w-full rounded-xl bg-stone-800 px-6 py-4 text-lg font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          表紙を作る
        </button>

      </div>
    </main>
  );
}
