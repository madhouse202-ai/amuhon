import {
  NOTO_SERIF_JP_FONT_FAMILY,
  NOTO_SERIF_JP_UNAVAILABLE_MESSAGE,
} from "./final-typography-preview.ts";

let fontLoad: Promise<void> | null = null;

/** Chromium may expose a FontFace family name with its CSS quotes included. */
export function isNotoSerifJpFontFamily(family: string): boolean {
  return family.replace(/[\"']/g, "").replace(/\s+/g, "").toLowerCase() === "notoserifjp";
}

/** Load the fixed development-only font endpoint; never fall back silently. */
export function ensureNotoSerifJpLoaded(): Promise<void> {
  if (process.env.NODE_ENV !== "development") {
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

      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "font/ttf" }));
      const face = new FontFace(NOTO_SERIF_JP_FONT_FAMILY, `url("${objectUrl}")`, { style: "normal" });
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
