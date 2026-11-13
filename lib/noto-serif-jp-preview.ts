import {
  NOTO_SERIF_CJK_JP_FAMILY,
  NOTO_SERIF_CJK_JP_REGULAR_POSTSCRIPT_NAME,
  NOTO_SERIF_JP_FONT_FAMILY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
} from "./final-typography-preview.ts";

let fontLoad: Promise<void> | null = null;

/** Chromium may expose a FontFace family name with its CSS quotes included. */
export function isNotoSerifJpFontFamily(family: string): boolean {
  const normalized = family.replace(/[\"']/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const logicalFamily = NOTO_SERIF_JP_FONT_FAMILY.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const internalFamily = NOTO_SERIF_CJK_JP_FAMILY.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === logicalFamily || normalized === internalFamily;
}

/** CDP must identify this exact custom font by its internal family or PostScript name. */
export function isNotoSerifJpRenderedFont(font: {
  familyName?: string;
  postScriptName?: string;
  isCustomFont?: boolean;
}): boolean {
  if (font.isCustomFont !== true) return false;
  const normalizedPostScript = (font.postScriptName ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const expectedPostScript = NOTO_SERIF_CJK_JP_REGULAR_POSTSCRIPT_NAME.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return font.familyName === NOTO_SERIF_CJK_JP_FAMILY ||
    normalizedPostScript === expectedPostScript;
}

/** Load the fixed preview font endpoint or the isolated renderer's intercepted, pinned font; never fall back silently. */
export function ensureNotoSerifJpLoaded(): Promise<void> {
  const isIsolatedPdfRenderer = typeof window !== "undefined" &&
    (window as Window & { __AMUHON_PDF_RENDERER_V1__?: boolean }).__AMUHON_PDF_RENDERER_V1__ === true;
  if (process.env.NODE_ENV !== "development" && !isIsolatedPdfRenderer) {
    return Promise.reject(new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE));
  }
  if (fontLoad) return fontLoad;

  fontLoad = (async () => {
    let objectUrl: string | null = null;
    try {
      const response = await fetch("/api/dev/final-typography-font", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 1024 || bytes.byteLength > 30_000_000) {
        throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
      }

      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "font/otf" }));
      const face = new FontFace(NOTO_SERIF_JP_FONT_FAMILY, `url("${objectUrl}")`, { style: "normal", weight: "400" });
      await face.load();
      if (face.status !== "loaded") throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
      document.fonts.add(face);

      const sample = "不思議な　縦書き・ルビ「注文」";
      const loaded = await document.fonts.load(`8.5pt "${NOTO_SERIF_JP_FONT_FAMILY}"`, sample);
      const matchingFace = loaded.find((loadedFace) =>
        isNotoSerifJpFontFamily(loadedFace.family) &&
        loadedFace.status === "loaded",
      );
      if (!matchingFace || !document.fonts.check(`8.5pt "${NOTO_SERIF_JP_FONT_FAMILY}"`, sample)) {
        throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
      }
    } catch {
      throw new Error(NOTO_SERIF_JP_UNAVAILABLE_MESSAGE);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  })().catch((error: unknown) => {
    fontLoad = null;
    throw error;
  });

  return fontLoad;
}
