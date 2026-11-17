"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BookWork } from "@/lib/book";
import { CreationProgress } from "@/app/creation-progress";
import { DraftSaveStatus } from "@/app/draft-save-status";
import { useBookDraftAutosave } from "@/lib/use-book-draft-autosave";

type WorkContributor = { name: string; role: string; reading: string };
type Work = BookWork & { contributors?: WorkContributor[] };
type PageEstimate = { status: "idle" | "loading" | "ready" | "error"; pages?: number };
type AuthorShelf = { author: string; workCount: number; sampleTitles: string[] };
type ListPage = { nextOffset: number; hasMore: boolean };

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

function groupShelfRows(works: Work[], maxRows = 4): Work[][] {
  if (works.length === 0) return [];
  const rowCount = Math.min(maxRows, works.length);
  const rowSize = Math.ceil(works.length / rowCount);
  return Array.from({ length: rowCount }, (_, index) => works.slice(index * rowSize, (index + 1) * rowSize)).filter((row) => row.length > 0);
}

function spineStyle(work: Work, index: number): { backgroundColor: string; height: number; width: number } {
  const palettes = ["#7f3f37", "#3d6255", "#4a5878", "#9a7548", "#58465f", "#506d79"];
  const hash = Array.from(work.id).reduce((sum, character) => sum + character.charCodeAt(0), index * 17);
  return {
    backgroundColor: palettes[hash % palettes.length],
    height: 166 + (hash % 5) * 11,
    width: 50 + (hash % 4) * 5,
  };
}

function safeAozoraUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" &&
      ["aozora.gr.jp", "www.aozora.gr.jp"].includes(url.hostname) && url.pathname.startsWith("/cards/")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
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

function WorkChoiceCard({
  work,
  estimate,
  selected,
  disabled,
  onAdd,
  onEstimate,
  onRetryEstimate,
  onDetails,
}: {
  work: Work;
  estimate: PageEstimate;
  selected: boolean;
  disabled: boolean;
  onAdd: (work: Work) => void;
  onEstimate: (work: Work) => void;
  onRetryEstimate: (work: Work) => void;
  onDetails: (work: Work, trigger: HTMLButtonElement) => void;
}) {
  const cardUrl = safeAozoraUrl(work.cardUrl);

  return (
    <article className="flex min-w-0 flex-col justify-between gap-4 rounded-2xl bg-white p-5 shadow-sm sm:flex-row sm:items-center">
      <div className="min-w-0">
        <h3 className="break-words text-xl font-bold">{work.title}</h3>
        <p className="mt-1 text-stone-600">{work.author || "作者情報なし"}</p>
        <button type="button" onClick={(event) => onDetails(work, event.currentTarget)} className="mt-2 min-h-11 text-left text-sm font-medium underline underline-offset-4">作品の詳細を見る</button>
        {cardUrl && (
          <a className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4" href={cardUrl} target="_blank" rel="noopener noreferrer">
            青空文庫の作品情報を見る
          </a>
        )}
        <EstimateWhenVisible
          work={work}
          estimate={estimate}
          onRequest={onEstimate}
          onRetry={onRetryEstimate}
        />
      </div>
      <button
        type="button"
        onClick={() => onAdd(work)}
        disabled={selected || disabled}
        aria-pressed={selected}
        className={`min-h-11 shrink-0 rounded-xl px-5 py-3 font-medium transition ${selected
          ? "bg-stone-200 text-stone-500"
          : "bg-stone-800 text-white hover:bg-stone-700 disabled:opacity-50"}`}
      >
        {selected ? "追加済み" : "＋ 本に加える"}
      </button>
    </article>
  );
}

export default function CreatePage() {
  const router = useRouter();
  const { draft, updateDraft, loadState, saveState, flushDraft } = useBookDraftAutosave();

  const [query, setQuery] = useState("");
  const [works, setWorks] = useState<Work[]>([]);
  const [discoveryMode, setDiscoveryMode] = useState<"shelf" | "search">("shelf");
  const [shelfMode, setShelfMode] = useState<"bookshelf" | "authors" | "works" | "author-works">("bookshelf");
  const [authorShelves, setAuthorShelves] = useState<AuthorShelf[]>([]);
  const [shelfWorks, setShelfWorks] = useState<Work[]>([]);
  const [listedWorks, setListedWorks] = useState<Work[]>([]);
  const [workListPage, setWorkListPage] = useState<ListPage>({ nextOffset: 0, hasMore: false });
  const [authorListPage, setAuthorListPage] = useState<ListPage>({ nextOffset: 0, hasMore: false });
  const [activeAuthor, setActiveAuthor] = useState("");
  const [authorWorks, setAuthorWorks] = useState<Work[]>([]);
  const [authorOffset, setAuthorOffset] = useState(0);
  const [authorHasMore, setAuthorHasMore] = useState(false);
  const authorRequestIdRef = useRef(0);
  const [isLoadingShelf, setIsLoadingShelf] = useState(true);
  const [isLoadingAuthorWorks, setIsLoadingAuthorWorks] = useState(false);
  const [shelfError, setShelfError] = useState("");
  const [refreshShelfError, setRefreshShelfError] = useState("");
  const [authorError, setAuthorError] = useState("");
  const [authorListError, setAuthorListError] = useState("");
  const [workListError, setWorkListError] = useState("");
  const [isLoadingAuthorList, setIsLoadingAuthorList] = useState(false);
  const [isLoadingWorkList, setIsLoadingWorkList] = useState(false);
  const [isRefreshingShelf, setIsRefreshingShelf] = useState(false);
  const [detailWork, setDetailWork] = useState<Work | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailDialogRef = useRef<HTMLElement | null>(null);
  const selectedWorks = draft.works;
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [pageEstimates, setPageEstimates] = useState<Record<string, PageEstimate>>({});
  const estimatedSelectedIdsRef = useRef(new Set<string>());
  const shelfWorkIdsRef = useRef<string[]>([]);

  const requestDiscovery = useCallback(async () => {
    setShelfError("");
    setIsLoadingShelf(true);
    try {
      const response = await fetch("/api/works?browse=discover", { cache: "no-store" });
      if (!response.ok) throw new Error("shelf_unavailable");
      const result = await response.json() as { works?: unknown };
      if (!Array.isArray(result.works)) throw new Error("shelf_invalid");
      setShelfWorks(result.works as Work[]);
      shelfWorkIdsRef.current = (result.works as Work[]).map((work) => work.id);
    } catch {
      setShelfError("本棚を読み込めませんでした。通信状態を確認して、もう一度お試しください。");
    } finally {
      setIsLoadingShelf(false);
    }
  }, []);

  const requestAnotherBookshelf = useCallback(async () => {
    setRefreshShelfError("");
    setIsRefreshingShelf(true);
    try {
      const params = new URLSearchParams({ browse: "discover" });
      if (shelfWorkIdsRef.current.length > 0) params.set("exclude", shelfWorkIdsRef.current.join(","));
      const response = await fetch(`/api/works?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("shelf_unavailable");
      const result = await response.json() as { works?: unknown };
      if (!Array.isArray(result.works) || result.works.some((work) => !work || typeof work.id !== "string")) throw new Error("shelf_invalid");
      const nextWorks = result.works as Work[];
      if (new Set(nextWorks.map((work) => work.id)).size !== nextWorks.length) throw new Error("shelf_duplicate");
      shelfWorkIdsRef.current = nextWorks.map((work) => work.id);
      setShelfWorks(nextWorks);
    } catch {
      setRefreshShelfError("本棚を入れ替えられませんでした。通信状態を確認して、もう一度お試しください。");
    } finally {
      setIsRefreshingShelf(false);
    }
  }, []);

  const requestAuthorList = useCallback(async (offset = 0, append = false) => {
    setAuthorListError("");
    setIsLoadingAuthorList(true);
    try {
      const response = await fetch(`/api/works?browse=authors&offset=${offset}`, { cache: "no-store" });
      if (!response.ok) throw new Error("authors_unavailable");
      const result = await response.json() as { authors?: unknown; nextOffset?: unknown; hasMore?: unknown };
      if (!Array.isArray(result.authors) || !Number.isSafeInteger(result.nextOffset) || typeof result.hasMore !== "boolean") throw new Error("authors_invalid");
      setAuthorShelves((current) => append ? [...current, ...(result.authors as AuthorShelf[])] : result.authors as AuthorShelf[]);
      setAuthorListPage({ nextOffset: result.nextOffset as number, hasMore: result.hasMore });
    } catch {
      setAuthorListError("作家一覧を読み込めませんでした。通信状態を確認して、再試行してください。");
    } finally {
      setIsLoadingAuthorList(false);
    }
  }, []);

  const requestWorkList = useCallback(async (offset = 0, append = false) => {
    setWorkListError("");
    setIsLoadingWorkList(true);
    try {
      const response = await fetch(`/api/works?browse=works&offset=${offset}`, { cache: "no-store" });
      if (!response.ok) throw new Error("works_unavailable");
      const result = await response.json() as { works?: unknown; nextOffset?: unknown; hasMore?: unknown };
      if (!Array.isArray(result.works) || !Number.isSafeInteger(result.nextOffset) || typeof result.hasMore !== "boolean") throw new Error("works_invalid");
      setListedWorks((current) => append ? [...current, ...(result.works as Work[])] : result.works as Work[]);
      setWorkListPage({ nextOffset: result.nextOffset as number, hasMore: result.hasMore });
    } catch {
      setWorkListError("作品一覧を読み込めませんでした。通信状態を確認して、再試行してください。");
    } finally {
      setIsLoadingWorkList(false);
    }
  }, []);

  const requestAuthorWorks = useCallback(async (author: string, offset = 0, append = false) => {
    const requestId = ++authorRequestIdRef.current;
    setAuthorError("");
    setIsLoadingAuthorWorks(true);
    try {
      const params = new URLSearchParams({ browse: "author", author, offset: String(offset) });
      const response = await fetch(`/api/works?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("author_unavailable");
      const result = await response.json() as { works?: unknown; nextOffset?: unknown; hasMore?: unknown };
      if (!Array.isArray(result.works) || !Number.isSafeInteger(result.nextOffset) || typeof result.hasMore !== "boolean") {
        throw new Error("author_invalid");
      }
      if (requestId !== authorRequestIdRef.current) return;
      setAuthorWorks((current) => append ? [...current, ...(result.works as Work[])] : result.works as Work[]);
      setAuthorOffset(result.nextOffset as number);
      setAuthorHasMore(result.hasMore);
    } catch {
      if (requestId !== authorRequestIdRef.current) return;
      setAuthorError("作品を読み込めませんでした。通信状態を確認して、再試行してください。");
    } finally {
      if (requestId === authorRequestIdRef.current) setIsLoadingAuthorWorks(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void requestDiscovery(); }, 0);
    return () => window.clearTimeout(timer);
  }, [requestDiscovery]);

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
        {
          id: work.id,
          title: work.title,
          author: work.author,
          cardUrl: work.cardUrl,
          textUrl: work.textUrl,
          xhtmlUrl: work.xhtmlUrl,
        },
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

  useEffect(() => {
    if (!detailWork) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailWork(null);
        window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = detailDialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailWork]);

  function showWorkDetails(work: Work, trigger: HTMLButtonElement) {
    detailTriggerRef.current = trigger;
    setDetailWork(work);
  }

  function closeWorkDetails() {
    setDetailWork(null);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }

  const renderWorkCard = (work: Work) => (
    <WorkChoiceCard
      key={work.id}
      work={work}
      estimate={pageEstimates[work.id] ?? { status: "idle" }}
      selected={isSelected(work.id)}
      disabled={loadState !== "ready"}
      onAdd={addWork}
      onEstimate={requestEstimate}
      onRetryEstimate={retryEstimate}
      onDetails={showWorkDetails}
    />
  );

  return (
    <main className="min-h-screen bg-stone-50 px-4 py-8 text-stone-800 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-3xl">

        <CreationProgress currentStep={1} />
        <div className="mb-5">
          <DraftSaveStatus loadState={loadState} saveState={saveState} onRetry={() => flushDraft()} />
        </div>

        <p className="text-sm tracking-widest text-stone-500">
          編む本
        </p>

        <h1 className="mt-4 text-3xl font-bold sm:text-4xl">
          本を編み始める
        </h1>

        <p className="mt-6 text-lg leading-8 text-stone-600">
          ここから、あなたの一冊をつくっていきます。
        </p>

        {/* 本棚からの選書を基本にし、検索も同じ画面から使えるようにする */}
        <section className="mt-10" aria-labelledby="work-discovery-heading">
          <h2 id="work-discovery-heading" className="text-2xl font-bold">作品を探す</h2>
          <p className="mt-2 text-stone-600">気になる物語を見つけたら、作品情報を読んで本に加えられます。</p>

          <div className="mt-5 flex flex-wrap gap-2" aria-label="作品の探し方">
            <button
              type="button"
              aria-pressed={discoveryMode === "shelf"}
              onClick={() => setDiscoveryMode("shelf")}
              className={`min-h-11 rounded-full px-4 py-2 font-medium ${discoveryMode === "shelf" ? "bg-stone-800 text-white" : "border border-stone-300 bg-white"}`}
            >本棚から探す</button>
            <button
              type="button"
              aria-pressed={discoveryMode === "search"}
              onClick={() => setDiscoveryMode("search")}
              className={`min-h-11 rounded-full px-4 py-2 font-medium ${discoveryMode === "search" ? "bg-stone-800 text-white" : "border border-stone-300 bg-white"}`}
            >検索する</button>
          </div>

          {discoveryMode === "shelf" ? (
            <div className="mt-6">
              <div className="flex flex-wrap gap-2" aria-label="作品の見つけ方">
                <button
                  type="button"
                  aria-pressed={shelfMode === "bookshelf"}
                  onClick={() => setShelfMode("bookshelf")}
                  className={`min-h-11 rounded-lg px-4 py-2 ${shelfMode === "bookshelf" ? "bg-amber-100 text-amber-950" : "bg-white text-stone-700"}`}
                >本棚</button>
                <button
                  type="button"
                  aria-pressed={shelfMode === "authors" || shelfMode === "author-works"}
                  onClick={() => {
                    setShelfMode("authors");
                    if (authorShelves.length === 0 && !isLoadingAuthorList) void requestAuthorList();
                  }}
                  className={`min-h-11 rounded-lg px-4 py-2 ${shelfMode === "authors" || shelfMode === "author-works" ? "bg-amber-100 text-amber-950" : "bg-white text-stone-700"}`}
                >作家一覧</button>
                <button
                  type="button"
                  aria-pressed={shelfMode === "works"}
                  onClick={() => {
                    setShelfMode("works");
                    if (listedWorks.length === 0 && !isLoadingWorkList) void requestWorkList();
                  }}
                  className={`min-h-11 rounded-lg px-4 py-2 ${shelfMode === "works" ? "bg-amber-100 text-amber-950" : "bg-white text-stone-700"}`}
                >作品一覧</button>
              </div>

              {shelfError && (
                <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5 text-red-900" role="alert">
                  <p>{shelfError}</p>
                  <button type="button" onClick={() => void requestDiscovery()} className="mt-3 min-h-11 rounded-lg border border-red-300 px-4 py-2 font-medium">本棚をもう一度読み込む</button>
                </div>
              )}
              {isLoadingShelf && <p className="mt-5 rounded-xl bg-white p-5 text-stone-600" role="status">本棚を準備しています…</p>}

              {!isLoadingShelf && !shelfError && shelfMode === "bookshelf" && (
                <div className="mt-5 rounded-2xl border border-amber-950/10 bg-[#eee5d4] p-3 shadow-inner sm:p-5">
                  <div className="mb-4 flex flex-wrap items-end justify-between gap-3 px-1">
                    <div>
                      <h3 className="text-lg font-bold text-stone-800">青空文庫の本棚</h3>
                      <p className="mt-1 text-sm text-stone-600">背表紙を選ぶと、作品のことを詳しく見られます。</p>
                    </div>
                    <button type="button" onClick={() => void requestAnotherBookshelf()} disabled={isRefreshingShelf} className="min-h-12 rounded-xl bg-amber-950 px-5 py-3 font-semibold text-white shadow-sm hover:bg-amber-900 disabled:opacity-60">
                      {isRefreshingShelf ? "本棚を整えています…" : "ほかの本棚を見る"}
                    </button>
                  </div>
                  {refreshShelfError && <p className="mb-3 text-sm text-red-800" role="alert">{refreshShelfError}</p>}
                  {shelfWorks.length > 0 ? (
                    <div className="space-y-5" aria-label="作品の本棚">
                      {groupShelfRows(shelfWorks).map((row, rowIndex) => (
                        <div key={`shelf-${rowIndex}`} className="overflow-x-auto overscroll-x-contain pb-1" aria-label={`${rowIndex + 1}段目の本棚`}>
                          <div className="flex min-w-max items-end gap-1.5 px-2 pt-3">
                            {row.map((work, index) => {
                              const style = spineStyle(work, index + rowIndex * row.length);
                              const selected = isSelected(work.id);
                              return (
                                <button
                                  key={work.id}
                                  type="button"
                                  onClick={(event) => showWorkDetails(work, event.currentTarget)}
                                  aria-label={`${work.title}、${work.author || "作者情報なし"}${selected ? "、本に追加済み" : ""}。作品の詳細を開く`}
                                  aria-pressed={selected}
                                  className="relative flex shrink-0 items-start justify-center overflow-hidden rounded-t-md border-x border-t border-black/20 px-2 pb-16 pt-3 text-left text-[#fff8e9] shadow-[2px_2px_5px_rgba(36,24,13,.28)] transition hover:-translate-y-1 hover:brightness-110 focus-visible:z-10 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
                                  style={{ backgroundColor: style.backgroundColor, height: style.height, width: style.width }}
                                >
                                  <span aria-hidden="true" className="absolute inset-y-0 left-1 w-px bg-white/20" />
                                  {selected && <span aria-hidden="true" className="absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-white text-xs font-bold text-emerald-900 shadow">✓</span>}
                                  <span className="overflow-hidden text-ellipsis text-center text-[15px] font-semibold leading-5 [text-orientation:upright] [writing-mode:vertical-rl]" style={{ maxHeight: style.height - 82 }}>{work.title}</span>
                                  <span className="absolute bottom-1 right-1 max-h-12 overflow-hidden text-ellipsis text-[10px] leading-3 [text-orientation:upright] [writing-mode:vertical-rl]">{work.author}</span>
                                </button>
                              );
                            })}
                          </div>
                          <div aria-hidden="true" className="h-3 rounded-sm border-t-2 border-[#bd9a69] bg-gradient-to-b from-[#9a7145] to-[#76512d] shadow-[0_5px_6px_rgba(50,31,13,.25)]" />
                        </div>
                      ))}
                    </div>
                  ) : <p className="rounded-xl bg-white/70 p-5 text-stone-600">本棚に表示できる作品がありません。</p>}
                  {shelfError && <p className="mt-3 text-sm text-red-800" role="alert">{shelfError}</p>}
                </div>
              )}

              {!isLoadingShelf && !shelfError && shelfMode === "authors" && (
                <div className="mt-5">
                  {authorShelves.length > 0 ? (
                    <>
                    <p className="mb-3 text-sm text-stone-600">青空文庫カタログに登録された著者名を読み順で表示します。</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                    {authorShelves.map((shelf) => (
                      <button
                          type="button"
                          key={shelf.author}
                          onClick={() => {
                            setActiveAuthor(shelf.author);
                            setAuthorWorks([]);
                            setAuthorOffset(0);
                            setShelfMode("author-works");
                            void requestAuthorWorks(shelf.author);
                          }}
                          className="flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-left hover:bg-stone-50"
                        ><span className="min-w-0"><strong className="block break-words">{shelf.author}</strong><span className="mt-1 block text-sm text-stone-600">{shelf.workCount}作品 · {shelf.sampleTitles.slice(0, 2).join("・")}</span></span><span aria-hidden="true" className="text-xl">›</span></button>
                    ))}
                    </div>
                    </>
                  ) : !isLoadingAuthorList && !authorListError ? <p className="rounded-xl bg-white p-5 text-stone-600">作家を表示できる作品がありません。</p> : null}
                    {isLoadingAuthorList && <p className="mt-4 text-sm text-stone-600" role="status">作家一覧を読み込んでいます…</p>}
                    {authorListError && <div className="mt-4 rounded-xl bg-red-50 p-4 text-red-900" role="alert"><p>{authorListError}</p><button type="button" onClick={() => void requestAuthorList()} className="mt-2 min-h-11 underline">再試行</button></div>}
                    {authorListPage.hasMore && <button type="button" onClick={() => void requestAuthorList(authorListPage.nextOffset, true)} disabled={isLoadingAuthorList} className="mt-4 min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2">{isLoadingAuthorList ? "読み込み中…" : "作家をもっと見る"}</button>}
                  </div>
              )}

              {!isLoadingShelf && !shelfError && shelfMode === "works" && (
                <div className="mt-5">
                  <p className="mb-3 text-sm text-stone-600">カタログの作品名順です。作品を選ぶと同じ詳細を開きます。</p>
                  {listedWorks.length > 0 ? (
                    <div className="grid gap-3">
                      {listedWorks.map(renderWorkCard)}
                    </div>
                  ) : !isLoadingWorkList && !workListError ? <p className="rounded-xl bg-white p-5 text-stone-600">作品一覧を表示できる作品がありません。</p> : null}
                  {isLoadingWorkList && <p className="mt-4 text-sm text-stone-600" role="status">作品一覧を読み込んでいます…</p>}
                  {workListError && <div className="mt-4 rounded-xl bg-red-50 p-4 text-red-900" role="alert"><p>{workListError}</p><button type="button" onClick={() => void requestWorkList()} className="mt-2 min-h-11 underline">再試行</button></div>}
                  {workListPage.hasMore && <button type="button" onClick={() => void requestWorkList(workListPage.nextOffset, true)} disabled={isLoadingWorkList} className="mt-4 min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2">{isLoadingWorkList ? "読み込み中…" : "作品をもっと見る"}</button>}
                </div>
              )}

              {shelfMode === "author-works" && (
                <div className="mt-5">
                  <button type="button" onClick={() => { authorRequestIdRef.current += 1; setIsLoadingAuthorWorks(false); setShelfMode("authors"); }} className="min-h-11 underline underline-offset-4">作家の棚へ戻る</button>
                  <h3 className="mt-3 break-words text-xl font-bold">{activeAuthor}</h3>
                  {isLoadingAuthorWorks && <p className="mt-4 text-stone-600" role="status">作品を読み込んでいます…</p>}
                  {authorError && (
                    <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-5 text-red-900" role="alert">
                      <p>{authorError}</p>
                      <button type="button" onClick={() => void requestAuthorWorks(activeAuthor)} className="mt-3 min-h-11 rounded-lg border border-red-300 px-4 py-2">もう一度読み込む</button>
                    </div>
                  )}
                  {!isLoadingAuthorWorks && !authorError && authorWorks.length === 0 && <p className="mt-4 text-stone-600">この作家の作品は見つかりませんでした。</p>}
                  <div className="mt-4 grid gap-3">{authorWorks.map(renderWorkCard)}</div>
                  {authorHasMore && (
                    <button type="button" onClick={() => void requestAuthorWorks(activeAuthor, authorOffset, true)} disabled={isLoadingAuthorWorks} className="mt-4 min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 disabled:opacity-50">
                      {isLoadingAuthorWorks ? "読み込み中…" : "この作家の作品をもっと見る"}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="mt-6">
              <p className="text-stone-600">作品名や作者名から探せます。</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSearchError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void searchWorks(); }}
                  placeholder="作品名や作者名を入力"
                  aria-label="作品名や作者名を検索"
                  className="min-h-12 min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-5 py-3 outline-none focus:border-stone-500"
                />
                <button type="button" onClick={() => void searchWorks()} disabled={isSearching || !query.trim()} className="min-h-12 rounded-xl bg-stone-800 px-6 py-3 font-medium text-white transition hover:bg-stone-700 disabled:opacity-50">
                  {isSearching ? "検索中…" : "検索"}
                </button>
              </div>
              {searchError && (
                <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5 text-red-900" role="alert">
                  <p>{searchError}</p>
                  <button type="button" onClick={() => void searchWorks()} disabled={isSearching || !query.trim()} className="mt-3 min-h-11 rounded-lg border border-red-300 px-4 py-2 font-medium disabled:opacity-50">もう一度検索する</button>
                </div>
              )}
              {searched && works.length === 0 && !isSearching && !searchError && (
                <p className="mt-5 rounded-xl bg-white p-6 text-center text-stone-500">作品が見つかりませんでした。</p>
              )}
              {works.length > 0 && (
                <div className="mt-5 grid gap-3">
                  {works.map(renderWorkCard)}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 選んだ作品 */}
        <section className="mt-12 rounded-2xl bg-white p-4 shadow-sm sm:mt-16 sm:p-8">
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
                    className="flex flex-col gap-3 rounded-xl bg-stone-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                  >
                    <div className="min-w-0 break-words">
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
                              ? "ページ数を確認できません"
                              : pageEstimates[work.id]?.status === "loading"
                                ? "ページ数を計算中…"
                                : "ページ数は未計算です"}
                        </span>
                        {pageEstimates[work.id]?.status === "error" && (
                          <button type="button" onClick={() => retryEstimate(work)} className="ml-2 min-h-10 underline underline-offset-4">
                            再計算
                          </button>
                        )}
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
                        aria-label={`${work.title}を上へ移動`}
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
                        aria-label={`${work.title}を下へ移動`}
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
                        aria-label={`${work.title}を本から削除`}
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
              : <p className="mt-5 text-sm text-stone-500" role="status">選択作品のページ数を計算しています（残り{unresolved}作品）。計算できない作品は、上の「再計算」をお試しください。</p>;
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
      {detailWork && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/55 p-0 sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWorkDetails(); }}>
          <section
            ref={detailDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="work-detail-title"
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-[#fffdf8] p-5 shadow-2xl sm:rounded-2xl sm:p-7"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-stone-500">青空文庫の作品</p>
                <h2 id="work-detail-title" className="mt-1 break-words text-2xl font-bold">{detailWork.title}</h2>
                <p className="mt-2 break-words text-stone-700">著者：{detailWork.author || "カタログに著者情報がありません"}</p>
              </div>
              <button type="button" autoFocus onClick={closeWorkDetails} aria-label="作品詳細を閉じる" className="grid size-11 shrink-0 place-items-center rounded-full border border-stone-300 text-2xl leading-none hover:bg-stone-100">×</button>
            </div>
            {detailWork.contributors && detailWork.contributors.some((person) => person.role && !["著者", "作者", "原著者"].includes(person.role)) && (
              <section className="mt-5 rounded-xl bg-stone-100 p-4" aria-label="関係者">
                <h3 className="font-semibold">関係者</h3>
                <ul className="mt-2 space-y-1 text-sm text-stone-700">
                  {detailWork.contributors.filter((person) => person.role && !["著者", "作者", "原著者"].includes(person.role)).map((person) => (
                    <li key={`${person.role}-${person.name}`}>{person.role}：{person.name}</li>
                  ))}
                </ul>
              </section>
            )}
            <div className="mt-5 rounded-xl border border-stone-200 p-4">
              <h3 className="font-semibold">作品情報</h3>
              <PageEstimateLabel estimate={pageEstimates[detailWork.id] ?? { status: "idle" }} onRetry={() => retryEstimate(detailWork)} />
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {safeAozoraUrl(detailWork.cardUrl) && <a className="min-h-11 inline-flex items-center underline underline-offset-4" href={safeAozoraUrl(detailWork.cardUrl) ?? undefined} target="_blank" rel="noopener noreferrer">図書カードを見る</a>}
                {safeAozoraUrl(detailWork.xhtmlUrl) && <a className="min-h-11 inline-flex items-center underline underline-offset-4" href={safeAozoraUrl(detailWork.xhtmlUrl) ?? undefined} target="_blank" rel="noopener noreferrer">青空文庫で本文を読む</a>}
              </div>
            </div>
            <button type="button" onClick={() => addWork(detailWork)} disabled={isSelected(detailWork.id) || loadState !== "ready"} aria-pressed={isSelected(detailWork.id)} className="mt-5 min-h-12 w-full rounded-xl bg-emerald-900 px-5 py-3 font-semibold text-white disabled:bg-stone-300 disabled:text-stone-600">
              {isSelected(detailWork.id) ? "この作品は本に入っています" : "この作品を本に追加"}
            </button>
            <button type="button" onClick={closeWorkDetails} className="mt-3 min-h-11 w-full rounded-xl border border-stone-300 px-4 py-2 font-medium">本棚に戻る</button>
          </section>
        </div>
      )}
    </main>
  );
}
