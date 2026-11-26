import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("cover confirmation persists the normalized draft before navigating without a blocking alert", async () => {
  const [coverPage, finalPage, book] = await Promise.all([
    source("../app/cover/page.tsx"),
    source("../app/final/page.tsx"),
    source("../lib/book.ts"),
  ]);
  const saveSettingsStart = coverPage.indexOf("function saveCoverSettings() {");
  const saveSettingsEnd = coverPage.indexOf("function handleSave() {", saveSettingsStart);
  const handleSaveEnd = coverPage.indexOf("function returnToWorkSelection() {", saveSettingsEnd);
  const saveSettings = coverPage.slice(saveSettingsStart, saveSettingsEnd);
  const handleSave = coverPage.slice(saveSettingsEnd, handleSaveEnd);

  assert.notEqual(saveSettingsStart, -1);
  assert.match(saveSettings, /flushDraft\(normalizedDraft\)/);
  assert.doesNotMatch(saveSettings, /updateDraft\(/);
  assert.match(handleSave, /if \(!saveCoverSettings\(\)\) return;\s*router\.push\("\/final"\);/);
  assert.doesNotMatch(handleSave, /alert\(/);

  // The final screen re-reads the synchronously persisted draft after navigation.
  assert.match(finalPage, /const book = loadBookData\(\)/);
  assert.match(book, /export function loadBookData\(\): BookData[\s\S]*?localStorage\.getItem\(STORAGE_KEY\)/);
});

test("returning to work selection keeps the same save-before-navigation contract", async () => {
  const coverPage = await source("../app/cover/page.tsx");

  assert.match(coverPage, /function returnToWorkSelection\(\) \{\s*if \(!saveCoverSettings\(\)\) return;\s*router\.push\("\/create"\);/);
});
