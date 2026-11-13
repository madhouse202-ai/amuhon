"use client";

import type { DraftLoadState, DraftSaveState } from "@/lib/use-book-draft-autosave";

export function DraftSaveStatus({
  loadState,
  saveState,
  onRetry,
}: {
  loadState: DraftLoadState;
  saveState: DraftSaveState;
  onRetry: () => void;
}) {
  if (loadState === "loading") {
    return <p className="text-xs text-stone-500" role="status">編集中の内容を読み込み中…</p>;
  }

  if (loadState === "error") {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
        保存データを読み込めませんでした。既存データを保護するため編集と自動保存を停止しています。ブラウザーの保存領域を確認して再読み込みしてください。
      </p>
    );
  }

  if (saveState === "error") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-amber-800" role="alert">
        <span>保存できませんでした。編集中の内容はこの画面に保持されています。</span>
        <button type="button" className="underline" onClick={onRetry}>保存を再試行</button>
      </p>
    );
  }

  const message = saveState === "saving"
    ? "保存中…"
    : saveState === "saved"
      ? "このブラウザーに保存済み"
      : "変更はこのブラウザーに自動保存されます";
  return <p className="text-xs text-stone-500" role="status" aria-live="polite">{message}</p>;
}
