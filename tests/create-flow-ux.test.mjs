import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the creation flow restores saved work order and goes directly from selection to cover", async () => {
  const [createPage, coverPage, legacyPreview] = await Promise.all([
    source("../app/create/page.tsx"),
    source("../app/cover/page.tsx"),
    source("../app/preview/page.tsx"),
  ]);

  assert.match(createPage, /useBookDraftAutosave\(\)/);
  assert.match(createPage, /selectedWorks = draft\.works/);
  assert.match(createPage, /flushDraft\(\{ \.\.\.draft, works: selectedWorks \}\)/);
  assert.match(createPage, /const moveWork = \(/);
  assert.match(createPage, /const handleDrop = \(/);
  assert.match(createPage, /const removeWork = \(/);
  assert.match(createPage, /router\.push\("\/cover"\)/);
  assert.doesNotMatch(createPage, /router\.push\([\s\S]{0,100}\/preview\?/);
  assert.match(createPage, /表紙を作る/);
  assert.match(createPage, /CreationProgress currentStep=\{1\}/);

  assert.match(coverPage, /function returnToWorkSelection\(\) \{\s*if \(!saveCoverSettings\(\)\) return;\s*router\.push\("\/create"\);/);
  assert.match(coverPage, /useBookDraftAutosave\(\)/);
  assert.match(coverPage, /作品を選び直す/);
  assert.match(coverPage, /CreationProgress[\s\S]{0,120}currentStep=\{2\}/);

  assert.match(legacyPreview, /export default function PreviewPage/);
  assert.match(legacyPreview, /CreationProgress currentStep=\{1\}/);
  assert.match(legacyPreview, /router\.push\("\/cover"\)/);
});

test("search failures are shown separately from empty results and can be retried", async () => {
  const createPage = await source("../app/create/page.tsx");

  assert.match(createPage, /const \[searchError, setSearchError\] = useState\(""\)/);
  assert.match(createPage, /setSearchError\("作品を検索できませんでした。通信状態を確認して、もう一度お試しください。"\)/);
  assert.match(createPage, /role="alert"/);
  assert.match(createPage, /もう一度検索する/);
  assert.match(createPage, /!searchError/);
});

test("the compact progress indicator is responsive and marks the active stage accessibly", async () => {
  const [progress, finalPage] = await Promise.all([
    source("../app/creation-progress.tsx"),
    source("../app/final/page.tsx"),
  ]);

  assert.match(progress, /aria-label="本づくりの工程"/);
  assert.match(progress, /aria-current="step"/);
  assert.match(progress, /grid grid-cols-3/);
  assert.match(progress, /sm:text-sm/);
  assert.match(finalPage, /CreationProgress currentStep=\{3\}/);
});
