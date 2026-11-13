import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { readBookDraft, saveBookData, trySaveBookDraft } from "../lib/book.ts";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

const storage = new Map();
const browserStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
};

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: browserStorage,
});

afterEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: browserStorage,
  });
});

const work = {
  id: "work-1",
  title: "作品",
  author: "著者",
  cardUrl: "/card",
  textUrl: "/text",
  xhtmlUrl: "/xhtml",
};

test("the existing draft format survives a page or browser restart", () => {
  const draft = {
    works: [work],
    title: "編集途中の本",
    editor: "編者名",
    coverStyle: "free",
    coverColor: "blue",
    coverPaperCode: "paper-06",
  };

  saveBookData(draft);
  const afterReload = readBookDraft();
  const afterBrowserRestart = readBookDraft();

  assert.equal(afterReload.status, "ready");
  assert.deepEqual(afterReload.data, draft);
  assert.equal(afterReload.hasSavedData, true);
  assert.deepEqual(afterBrowserRestart, afterReload);
  assert.deepEqual(Object.keys(JSON.parse(storage.get("amuhon-book"))).sort(), [
    "coverColor", "coverPaperCode", "coverStyle", "editor", "title", "works",
  ]);
});

test("a missing draft starts with the compatible defaults without writing over storage", () => {
  const result = readBookDraft();

  assert.equal(result.status, "ready");
  assert.equal(result.hasSavedData, false);
  assert.deepEqual(result.data.works, []);
  assert.equal(storage.has("amuhon-book"), false);
});

test("corrupt saved data is reported and left untouched", () => {
  storage.set("amuhon-book", "{not-json");

  assert.deepEqual(readBookDraft(), { status: "corrupt" });
  assert.equal(storage.get("amuhon-book"), "{not-json");
});

test("valid JSON with an invalid draft shape is not treated as an empty draft", () => {
  const raw = JSON.stringify({ works: "not-an-array", title: "既存データ" });
  storage.set("amuhon-book", raw);

  assert.deepEqual(readBookDraft(), { status: "corrupt" });
  assert.equal(storage.get("amuhon-book"), raw);
});

test("a failed storage write does not replace the last saved draft", () => {
  const previous = JSON.stringify({ works: [work], title: "前の保存内容" });
  storage.set("amuhon-book", previous);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      ...browserStorage,
      getItem: browserStorage.getItem,
      setItem() { throw new Error("quota exceeded"); },
    },
  });

  assert.equal(trySaveBookDraft({
    works: [],
    title: "現在の編集中データ",
    editor: "編者",
    coverStyle: "classic",
    coverColor: "red",
  }), false);
  assert.equal(storage.get("amuhon-book"), previous);
});

test("inaccessible browser storage fails closed", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem() { throw new Error("storage unavailable"); } },
  });

  assert.deepEqual(readBookDraft(), { status: "unavailable" });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: browserStorage,
  });
});

test("the screens debounce edits, flush before leaving, and expose save status", async () => {
  const [hook, createPage, coverPage] = await Promise.all([
    readSource("../lib/use-book-draft-autosave.ts"),
    readSource("../app/create/page.tsx"),
    readSource("../app/cover/page.tsx"),
  ]);

  assert.match(hook, /const AUTOSAVE_DELAY_MS = 300/);
  assert.match(hook, /readBookDraft\(\)/);
  assert.match(hook, /loadStateRef\.current !== "ready"/);
  assert.match(hook, /if \(!trySaveBookDraft\(nextDraft\)\)[\s\S]*?pendingDraftRef\.current = nextDraft/);
  assert.match(hook, /addEventListener\("pagehide"/);
  assert.match(hook, /addEventListener\("beforeunload"/);
  assert.match(hook, /if \(pendingDraftRef\.current\) persistDraft\(pendingDraftRef\.current\)/);
  assert.match(createPage, /selectedWorks = draft\.works/);
  assert.match(createPage, /flushDraft\(\{ \.\.\.draft, works: selectedWorks \}\)/);
  assert.match(coverPage, /updateDraft\(\(current\) => \(\{ \.\.\.current, title: e\.target\.value \}\)\)/);
  assert.match(coverPage, /updateDraft\(\(current\) => \(\{ \.\.\.current, editor: e\.target\.value \}\)\)/);
  assert.match(coverPage, /if \(!saveCoverSettings\(\)\) return/);
  assert.match(coverPage, /allowCompletedNavigation=\{saveState === "idle" \|\| saveState === "saved"\}/);
  assert.match(createPage, /<DraftSaveStatus/);
  assert.match(coverPage, /<DraftSaveStatus/);
});
