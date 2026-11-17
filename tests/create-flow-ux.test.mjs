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

test("work discovery opens on real author and work shelves while keeping search available", async () => {
  const [createPage, catalogRoute] = await Promise.all([
    source("../app/create/page.tsx"),
    source("../app/api/works/route.ts"),
  ]);

  assert.match(createPage, /useState<"shelf" \| "search">\("shelf"\)/);
  assert.match(createPage, /本棚から探す/);
  assert.match(createPage, /作家一覧/);
  assert.match(createPage, /作品一覧/);
  assert.match(createPage, /検索する/);
  assert.match(createPage, /ほかの本棚を見る/);
  assert.match(createPage, /groupShelfRows\(shelfWorks\)/);
  assert.match(createPage, /writing-mode:vertical-rl|writing-mode: vertical-rl|\[writing-mode:vertical-rl\]/);
  assert.match(createPage, /role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(createPage, /onDetails=\{showWorkDetails\}/);
  assert.match(createPage, /event\.key === "Escape"/);
  assert.match(createPage, /event\.shiftKey && document\.activeElement === first/);
  assert.match(createPage, /detailTriggerRef\.current\?\.focus\(\)/);
  assert.match(createPage, /青空文庫で本文を読む/);
  assert.match(createPage, /この作品を本に追加/);
  assert.match(createPage, /この作家の作品をもっと見る/);
  assert.match(createPage, /青空文庫の作品情報を見る/);
  assert.match(createPage, /authorRequestIdRef/);
  assert.match(catalogRoute, /役割フラグ/);
  assert.match(catalogRoute, /buildAuthorEntries/);
  assert.match(catalogRoute, /browse === "authors"/);
  assert.match(catalogRoute, /browse === "works"/);
  assert.match(catalogRoute, /exclude/);
  assert.match(catalogRoute, /sampleTitles:/);
  assert.doesNotMatch(catalogRoute, /rating|popularity|genre|紹介文/);
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
