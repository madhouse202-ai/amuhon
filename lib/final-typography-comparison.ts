import {
  CHARS_PER_COLUMN,
  COLUMNS_PER_PAGE,
  splitTextIntoPages,
  unitCharacterCount,
  type LayoutUnit,
} from "./book-layout.ts";

export const COMPARISON_PAGE_WIDTH_MM = 105;
export const COMPARISON_PAGE_HEIGHT_MM = 148;
export const COMPARISON_BODY_FONT_SIZE_PT = 8.5;
export const COMPARISON_CONTENT_WIDTH_MM = 87;
export const COMPARISON_CONTENT_HEIGHT_MM = 126;
export const COMPARISON_COLUMN_WIDTH_MM = 5.4;
export const COMPARISON_BODY_TOP_MM = 10;
export const COMPARISON_COLUMN_SAFETY_MM = 2;
export const LONG_COMPARISON_MIN_PAGES = 50;
export const LONG_COMPARISON_MAX_PAGES = 80;
const LONG_COMPARISON_TARGET_PAGES = 60;
const POINT_TO_MM = 25.4 / 72;

/**
 * Short, public-domain source excerpts pinned in the tool so runs do not depend
 * on browser state, an API, the network, a database, or changing catalog data.
 * The repeated fixture is a layout stress corpus, not a reproduction of the
 * user's current anthology or a complete edition of any of these works.
 */
export const LONG_FIXTURE_SOURCES = [
  {
    title: "注文の多い料理店",
    author: "宮沢賢治",
    url: "https://www.aozora.gr.jp/cards/000081/files/43754_17659.html",
  },
  {
    title: "蜜柑",
    author: "芥川龍之介",
    url: "https://www.aozora.gr.jp/cards/000879/files/98_15272.html",
  },
  {
    title: "走れメロス",
    author: "太宰治",
    url: "https://www.aozora.gr.jp/cards/000035/files/1567_14913.html",
  },
  {
    title: "山月記",
    author: "中島敦",
    url: "https://www.aozora.gr.jp/cards/000119/files/624_14544.html",
  },
] as const;

const SOURCE_PARAGRAPHS = [
  "二人の若い紳士《しんし》が、鉄砲《てっぽう》をかつぎ、白熊《しろくま》のような犬をつれて、山奥《やまおく》を歩いておりました。",
  "これらはその時《とき》の私《わたくし》の心もちと、不思議《ふしぎ》な位《くらゐ》似《に》つかはしい景色《けしき》だつた。",
  "路行《みちゆ》く人を押《お》しのけ、跳《は》ねとばし、メロスは黒い風のように走った。",
  "隴西《ろうさい》の李徴《りちょう》は博学才穎《はくがくさいえい》、若くして名を虎榜《こぼう》に連ねた。",
] as const;

const RUBY_HEAVY_PARAGRAPH =
  "｜蜜柑《みかん》が｜降《ふ》る｜景色《けしき》を｜眺《なが》め、｜心《こころ》を｜動《うご》かされた。｜美《うつく》しい｜色《いろ》が｜窓《まど》に｜映《うつ》る。";
const PUNCTUATION_PARAGRAPH = "「そうか――。」（『蜜柑』、驚き！）……「次へ。」『括弧』と、句読点。！？を続けて確認する。";
const PAGE_END_PHRASE = "本文組版確認";

export type TypographyVariant = {
  id: "A" | "B" | "C" | "D";
  label: string;
  fontFamily: string;
  trackingEm: number;
};

/** Phase 1 variants remain available for short, four-way comparisons. */
export const TYPOGRAPHY_VARIANTS: readonly TypographyVariant[] = [
  { id: "A", label: "A｜現行 serif・1.00em", fontFamily: "serif", trackingEm: 0 },
  { id: "B", label: "B｜現行 serif・1.02em", fontFamily: "serif", trackingEm: 0.02 },
  { id: "C", label: "C｜現行 serif・1.03em", fontFamily: "serif", trackingEm: 0.03 },
  { id: "D", label: "D｜Noto Serif JP・1.00em", fontFamily: '"Noto Serif JP", serif', trackingEm: 0 },
];

/** Phase 2 compares only the requested baseline, 2% tracking, and Noto font. */
export const LONG_TYPOGRAPHY_VARIANTS: readonly TypographyVariant[] = [
  TYPOGRAPHY_VARIANTS[0],
  TYPOGRAPHY_VARIANTS[1],
  TYPOGRAPHY_VARIANTS[3],
];

export type TypographyVariantGeometry = {
  charAdvanceMm: number;
  fortyCharacterAdvanceMm: number;
  requiredColumnHeightMm: number;
  remainingBodyHeightMm: number;
};

export type TypographyFeaturePageIndexes = {
  mikanPhrase: number;
  rubyHeavy: number;
  punctuation: number;
  pageEnd: number;
};

export type LongTypographyFixture = {
  text: string;
  pageCount: number;
  columnCount: number;
  featurePageIndexes: TypographyFeaturePageIndexes;
  sources: typeof LONG_FIXTURE_SOURCES;
  description: string;
};

/** Short baseline fixture retained for phase-1 A/B/C/D comparisons. */
export const TYPOGRAPHY_COMPARISON_TEXT = createShortComparisonText();

export function getTypographyVariantGeometry(trackingEm: number): TypographyVariantGeometry {
  const charAdvanceMm = COMPARISON_BODY_FONT_SIZE_PT * POINT_TO_MM * (1 + trackingEm);
  const fortyCharacterAdvanceMm = charAdvanceMm * CHARS_PER_COLUMN;
  const requiredColumnHeightMm = fortyCharacterAdvanceMm + COMPARISON_COLUMN_SAFETY_MM;
  return {
    charAdvanceMm,
    fortyCharacterAdvanceMm,
    requiredColumnHeightMm,
    remainingBodyHeightMm: COMPARISON_CONTENT_HEIGHT_MM - requiredColumnHeightMm,
  };
}

export function getTypographyComparisonLayouts(options: {
  text?: string;
  variants?: readonly TypographyVariant[];
} = {}) {
  const text = options.text ?? TYPOGRAPHY_COMPARISON_TEXT;
  const variants = options.variants ?? TYPOGRAPHY_VARIANTS;
  const pages = splitTextIntoPages(text);
  const columns = pages.flat();
  const maximumColumnCharacters = Math.max(
    0,
    ...columns.map((column) => column.reduce((total, unit) => total + unitCharacterCount(unit), 0)),
  );

  return variants.map((variant) => {
    const geometry = getTypographyVariantGeometry(variant.trackingEm);
    if (geometry.requiredColumnHeightMm > COMPARISON_CONTENT_HEIGHT_MM) {
      throw new Error(`Variant ${variant.id} does not fit 40 characters in the A6 body area.`);
    }
    if (maximumColumnCharacters > CHARS_PER_COLUMN || columns.length > pages.length * COLUMNS_PER_PAGE) {
      throw new Error(`Variant ${variant.id} exceeds the current logical page grid.`);
    }

    return {
      ...variant,
      ...geometry,
      pages,
      pageCount: pages.length,
      columnCount: columns.length,
      maximumColumnCharacters,
    };
  });
}

export function createLongTypographyFixture(): LongTypographyFixture {
  const paragraphs: string[] = [];
  const featurePageIndexes: Partial<TypographyFeaturePageIndexes> = {};
  const currentColumnCount = () => splitTextIntoPages(paragraphs.join("\n\n")).flat().length;
  const appendFeature = (feature: keyof Omit<TypographyFeaturePageIndexes, "pageEnd">, paragraph: string) => {
    featurePageIndexes[feature] = Math.floor(currentColumnCount() / COLUMNS_PER_PAGE);
    paragraphs.push(paragraph);
  };

  // Keep the displayed source order. The first Mikan paragraph contains the
  // reported “不思議な” spacing case from the existing phase-1 review.
  paragraphs.push(SOURCE_PARAGRAPHS[0]);
  appendFeature("mikanPhrase", SOURCE_PARAGRAPHS[1]);
  paragraphs.push(SOURCE_PARAGRAPHS[2], SOURCE_PARAGRAPHS[3]);

  let cycle = 0;
  const appendWorkCycle = () => {
    for (const paragraph of SOURCE_PARAGRAPHS) paragraphs.push(paragraph);
    cycle += 1;
  };
  while (splitTextIntoPages(paragraphs.join("\n\n")).length < 18) appendWorkCycle();
  appendFeature("rubyHeavy", RUBY_HEAVY_PARAGRAPH);

  while (splitTextIntoPages(paragraphs.join("\n\n")).length < 36) appendWorkCycle();
  appendFeature("punctuation", PUNCTUATION_PARAGRAPH);

  while (splitTextIntoPages(paragraphs.join("\n\n")).length < LONG_COMPARISON_TARGET_PAGES - 1) appendWorkCycle();

  // Fill the last logical page to its sixteenth column and close with a quote.
  const existingColumns = currentColumnCount();
  const columnsToPageEnd = COLUMNS_PER_PAGE - (existingColumns % COLUMNS_PER_PAGE);
  const pageEndCharacters = columnsToPageEnd * CHARS_PER_COLUMN;
  const pageEndBody = Array.from({ length: Math.max(0, pageEndCharacters - 3) }, (_, index) =>
    Array.from(PAGE_END_PHRASE)[index % Array.from(PAGE_END_PHRASE).length],
  ).join("");
  paragraphs.push(`「${pageEndBody}、」`);

  const text = paragraphs.join("\n\n");
  const pages = splitTextIntoPages(text);
  const columns = pages.flat();
  const pageEnd = pages.length - 1;
  const maxColumnCharacters = Math.max(
    0,
    ...columns.map((column) => column.reduce((total, unit) => total + unitCharacterCount(unit), 0)),
  );

  if (pages.length < LONG_COMPARISON_MIN_PAGES || pages.length > LONG_COMPARISON_MAX_PAGES) {
    throw new Error(`Long typography fixture must be ${LONG_COMPARISON_MIN_PAGES}–${LONG_COMPARISON_MAX_PAGES} pages; got ${pages.length}.`);
  }
  if (maxColumnCharacters > CHARS_PER_COLUMN || columns.length > pages.length * COLUMNS_PER_PAGE) {
    throw new Error("Long typography fixture exceeds the existing 40 × 16 logical page grid.");
  }
  if (columns.at(-1)?.at(-1)?.text !== "」") {
    throw new Error("Long typography fixture did not finish on the final column with its closing quote.");
  }

  return {
    text,
    pageCount: pages.length,
    columnCount: columns.length,
    featurePageIndexes: {
      mikanPhrase: featurePageIndexes.mikanPhrase ?? 0,
      rubyHeavy: featurePageIndexes.rubyHeavy ?? 0,
      punctuation: featurePageIndexes.punctuation ?? 0,
      pageEnd,
    },
    sources: LONG_FIXTURE_SOURCES,
    description: `Deterministic ${cycle}-cycle public-domain excerpt fixture; not the user's live anthology or complete work texts.`,
  };
}

export function renderTypographyColumnHtml(column: LayoutUnit[] | null, trackingEm: number): string {
  if (!column) return '<div class="column" lang="ja"></div>';
  let inlineOffsetEm = 0;
  const cells = column.map((unit) => {
    const count = unitCharacterCount(unit);
    const advance = count * (1 + trackingEm);
    const cell = `<span class="print-character-cell" data-character-count="${count}" data-start-em="${inlineOffsetEm}" data-advance-em="${advance}" style="inset-inline-start:${inlineOffsetEm}em;inline-size:${advance}em">${escapeHtml(unit.text)}${unit.ruby ? `<span class="print-character-cell__ruby">${escapeHtml(unit.ruby)}</span>` : ""}</span>`;
    inlineOffsetEm += advance;
    return cell;
  }).join("");
  return `<div class="column" lang="ja">${cells}</div>`;
}

function createShortComparisonText(): string {
  const samples = [
    SOURCE_PARAGRAPHS[1],
    RUBY_HEAVY_PARAGRAPH,
    PUNCTUATION_PARAGRAPH,
  ];
  const reviewColumns = splitTextIntoPages(samples.join("\n\n")).flat().length;
  const columnsToPageEnd = COLUMNS_PER_PAGE - (reviewColumns % COLUMNS_PER_PAGE);
  const pageEndCharacterCount = columnsToPageEnd * CHARS_PER_COLUMN;
  const phrase = Array.from("その時の私の心もちと不思議な位似つかはしい景色だつた");
  const pageEndPrefix = Array.from({ length: pageEndCharacterCount - 3 }, (_, index) => phrase[index % phrase.length]).join("");
  return [...samples, `「${pageEndPrefix}、」`].join("\n\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
