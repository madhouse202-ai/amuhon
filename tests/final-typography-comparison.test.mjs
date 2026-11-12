import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMPARISON_CONTENT_HEIGHT_MM,
  COMPARISON_PAGE_HEIGHT_MM,
  COMPARISON_PAGE_WIDTH_MM,
  LONG_COMPARISON_MAX_PAGES,
  LONG_COMPARISON_MIN_PAGES,
  LONG_TYPOGRAPHY_VARIANTS,
  createLongTypographyFixture,
  TYPOGRAPHY_COMPARISON_TEXT,
  TYPOGRAPHY_VARIANTS,
  getTypographyComparisonLayouts,
  getTypographyVariantGeometry,
} from "../lib/final-typography-comparison.ts";

test("comparison keeps A as baseline and B/C advance positions by 2%/3%", () => {
  assert.deepEqual(TYPOGRAPHY_VARIANTS.map(({ id, trackingEm }) => [id, trackingEm]), [
    ["A", 0], ["B", 0.02], ["C", 0.03], ["D", 0],
  ]);
  assert.equal(COMPARISON_PAGE_WIDTH_MM, 105);
  assert.equal(COMPARISON_PAGE_HEIGHT_MM, 148);
  assert.ok(getTypographyVariantGeometry(0.02).charAdvanceMm > getTypographyVariantGeometry(0).charAdvanceMm);
  assert.ok(getTypographyVariantGeometry(0.03).charAdvanceMm > getTypographyVariantGeometry(0.02).charAdvanceMm);
});

test("all four variants fit 40 characters inside the A6 body area and keep identical pagination", () => {
  const layouts = getTypographyComparisonLayouts();
  assert.equal(new Set(layouts.map((layout) => layout.pageCount)).size, 1);
  assert.equal(new Set(layouts.map((layout) => layout.columnCount)).size, 1);
  assert.equal(layouts[0].pages[0].length, 16, "the case study should reach the last column on the page");
  assert.equal(layouts[0].pages[0].at(-1)?.at(-1)?.text, "」", "the final column should end with the closing quote");
  for (const layout of layouts) {
    assert.ok(layout.requiredColumnHeightMm <= COMPARISON_CONTENT_HEIGHT_MM, layout.id);
    assert.ok(layout.maximumColumnCharacters <= 40, layout.id);
    assert.equal(layout.maximumColumnCharacters, 40, layout.id);
    assert.ok(layout.remainingBodyHeightMm >= 0, layout.id);
  }
  assert.match(TYPOGRAPHY_COMPARISON_TEXT, /不思議《ふしぎ》な/);
  assert.match(TYPOGRAPHY_COMPARISON_TEXT, /「.*」（.*）/s);
});

test("phase 2 uses the same deterministic 50–80 page body for A, B, and D", () => {
  const fixture = createLongTypographyFixture();
  const layouts = getTypographyComparisonLayouts({ text: fixture.text, variants: LONG_TYPOGRAPHY_VARIANTS });

  assert.deepEqual(LONG_TYPOGRAPHY_VARIANTS.map(({ id, trackingEm }) => [id, trackingEm]), [
    ["A", 0], ["B", 0.02], ["D", 0],
  ]);
  assert.ok(fixture.pageCount >= LONG_COMPARISON_MIN_PAGES);
  assert.ok(fixture.pageCount <= LONG_COMPARISON_MAX_PAGES);
  assert.equal(fixture.pageCount, layouts[0].pageCount);
  assert.equal(new Set(layouts.map((layout) => layout.pageCount)).size, 1);
  assert.equal(new Set(layouts.map((layout) => layout.columnCount)).size, 1);
  assert.deepEqual(layouts.map((layout) => layout.pages), [layouts[0].pages, layouts[0].pages, layouts[0].pages]);
  assert.match(fixture.text, /不思議《ふしぎ》な/);
  assert.match(fixture.text, /｜蜜柑《みかん》/);
  assert.match(fixture.text, /「そうか――。」（『蜜柑』、驚き！）/);
  assert.ok(fixture.featurePageIndexes.mikanPhrase >= 0);
  assert.ok(fixture.featurePageIndexes.rubyHeavy >= 0);
  assert.ok(fixture.featurePageIndexes.punctuation >= 0);
  assert.equal(fixture.featurePageIndexes.pageEnd, fixture.pageCount - 1);
  assert.equal(layouts[0].pages.at(-1)?.at(-1)?.at(-1)?.text, "」");

  for (const layout of layouts) {
    assert.equal(layout.maximumColumnCharacters, 40);
    for (const page of layout.pages) {
      assert.ok(page.length <= 16);
      for (const column of page) {
        assert.ok(column.reduce((sum, unit) => sum + Array.from(unit.text).length, 0) <= 40);
      }
    }
    assert.ok(layout.requiredColumnHeightMm <= COMPARISON_CONTENT_HEIGHT_MM);
  }
  assert.ok(fixture.sources.some(({ title }) => title === "注文の多い料理店"));
  assert.ok(fixture.sources.some(({ title }) => title === "蜜柑"));
  assert.ok(fixture.sources.some(({ title }) => title === "走れメロス"));
  assert.ok(fixture.sources.some(({ title }) => title === "山月記"));
});

test("the production final page and print defaults are unchanged", async () => {
  const [finalPage, css, bookLayout, script, comparisonLib, gitignore] = await Promise.all([
    readFile(new URL("../app/final/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/book-layout.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/compare-final-typography.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/final-typography-comparison.ts", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.match(finalPage, /const BODY_FONT_SIZE_PT = 8\.5/);
  assert.match(finalPage, /width: CONTENT_WIDTH/);
  assert.match(finalPage, /writingMode:\s*"vertical-rl"/);
  assert.match(finalPage, /textOrientation:\s*"mixed"/);
  const bodyPage = finalPage.split("function BodyPage({")[1]?.split("function ColophonPage")[0] ?? "";
  assert.match(bodyPage, /bodyTypography === "noto-serif-jp" \? '\"Noto Serif JP\", serif' : "serif"/);
  assert.match(finalPage, /lineHeight:\s*1/);
  assert.match(finalPage, /letterSpacing:\s*"0"/);
  assert.match(finalPage, /lineBreak:\s*"strict"/);
  assert.match(finalPage, /wordBreak:\s*"normal"/);
  assert.match(finalPage, /whiteSpace:\s*"nowrap"/);
  assert.match(finalPage, /insetInlineStart: `\$\{inlineOffset\}em`/);
  assert.match(finalPage, /inlineSize: `\$\{unitCharacterCount\(unit\)\}em`/);
  assert.match(bookLayout, /CHARS_PER_COLUMN = 40/);
  assert.match(bookLayout, /COLUMNS_PER_PAGE = 16/);
  assert.match(css, /size: 105mm 148mm/);
  assert.match(css, /\.print-character-cell\s*\{[^}]*block-size:\s*1em[^}]*line-height:\s*1/s);
  assert.match(css, /\.print-character-cell__ruby\s*\{[^}]*font-size:\s*0\.5em/s);
  assert.match(css, /letter-spacing:\s*0 !important/);
  assert.match(script, /writing-mode: vertical-rl/);
  assert.match(script, /text-orientation: mixed/);
  assert.match(script, /letter-spacing: 0/);
  assert.match(script, /font-size: \$\{COMPARISON_BODY_FONT_SIZE_PT\}pt/);
  assert.match(script, /NODE_ENV === "production"/);
  assert.match(script, /page\.pdf\(/);
  assert.match(script, /createLongTypographyFixture/);
  assert.match(script, /LONG_TYPOGRAPHY_VARIANTS/);
  assert.match(script, /cellOverflowCount/);
  assert.match(script, /baseCellOverlapCount/);
  assert.match(script, /rubyNeighborOverlapCount/);
  assert.match(script, /pageEnd/);
  assert.match(comparisonLib, /data-character-count/);
  assert.match(script, /fixtureSha256/);
  assert.match(script, /typography-\$\{featureName\}-\$\{variantSet\}-comparison\.png/);
  assert.doesNotMatch(script, /supabase|stripe|fetch\s*\(/i);
  assert.match(script, /args\.some\(\(argument\) => argument !== "--short"\)/);
  assert.match(gitignore, /\/tmp\/final-typography-comparison\//);
});
