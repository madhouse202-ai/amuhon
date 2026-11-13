"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { defaultBookData, readBookDraft, trySaveBookDraft, type BookData } from "@/lib/book";

const AUTOSAVE_DELAY_MS = 300;

export type DraftLoadState = "loading" | "ready" | "error";
export type DraftSaveState = "idle" | "saving" | "saved" | "error";

export function useBookDraftAutosave() {
  const [draft, setDraft] = useState<BookData>(defaultBookData);
  const [loadState, setLoadState] = useState<DraftLoadState>("loading");
  const [saveState, setSaveState] = useState<DraftSaveState>("idle");
  const draftRef = useRef(draft);
  const loadStateRef = useRef<DraftLoadState>("loading");
  const canWriteRef = useRef(false);
  const lastSavedJsonRef = useRef<string | null>(null);
  const pendingDraftRef = useRef<BookData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistDraft = useCallback((nextDraft: BookData) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!canWriteRef.current) {
      setSaveState("error");
      return false;
    }

    if (!trySaveBookDraft(nextDraft)) {
      // Keep the current draft in memory so a user edit or explicit retry can save it later.
      pendingDraftRef.current = nextDraft;
      setSaveState("error");
      return false;
    }

    draftRef.current = nextDraft;
    lastSavedJsonRef.current = JSON.stringify(nextDraft);
    pendingDraftRef.current = null;
    setSaveState("saved");
    return true;
  }, []);

  const flushDraft = useCallback((nextDraft?: BookData) => {
    return persistDraft(nextDraft ?? pendingDraftRef.current ?? draftRef.current);
  }, [persistDraft]);

  const updateDraft = useCallback((update: SetStateAction<BookData>) => {
    if (loadStateRef.current !== "ready") return;
    const nextDraft = typeof update === "function" ? update(draftRef.current) : update;
    const nextJson = JSON.stringify(nextDraft);
    draftRef.current = nextDraft;
    setDraft(nextDraft);

    if (nextJson === lastSavedJsonRef.current) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingDraftRef.current = null;
      setSaveState("saved");
      return;
    }

    pendingDraftRef.current = nextDraft;
    setSaveState("saving");
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persistDraft(nextDraft);
    }, AUTOSAVE_DELAY_MS);
  }, [persistDraft]);

  useEffect(() => {
    const result = readBookDraft();
    if (result.status === "ready") {
      draftRef.current = result.data;
      lastSavedJsonRef.current = JSON.stringify(result.data);
      canWriteRef.current = true;
      loadStateRef.current = "ready";
      // Read browser storage after mount to avoid server/client render differences.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(result.data);
      setLoadState("ready");
      setSaveState(result.hasSavedData ? "saved" : "idle");
      return;
    }

    // Do not replace malformed or inaccessible existing storage with an empty draft.
    loadStateRef.current = "error";
    canWriteRef.current = false;
    setLoadState("error");
    setSaveState("error");
  }, []);

  useEffect(() => {
    const flushPending = () => {
      if (pendingDraftRef.current) persistDraft(pendingDraftRef.current);
    };
    const confirmIfUnsaved = (event: BeforeUnloadEvent) => {
      if (!pendingDraftRef.current) return;
      if (!persistDraft(pendingDraftRef.current)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", flushPending);
    window.addEventListener("beforeunload", confirmIfUnsaved);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      window.removeEventListener("beforeunload", confirmIfUnsaved);
      if (pendingDraftRef.current) persistDraft(pendingDraftRef.current);
      else if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [persistDraft]);

  return { draft, updateDraft, loadState, saveState, flushDraft };
}
