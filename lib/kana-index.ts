export const GOJUON_ROWS = [
  ["あ", "い", "う", "え", "お"],
  ["か", "き", "く", "け", "こ"],
  ["さ", "し", "す", "せ", "そ"],
  ["た", "ち", "つ", "て", "と"],
  ["な", "に", "ぬ", "ね", "の"],
  ["は", "ひ", "ふ", "へ", "ほ"],
  ["ま", "み", "む", "め", "も"],
  ["や", "ゆ", "よ"],
  ["ら", "り", "る", "れ", "ろ"],
  ["わ", "を", "ん"],
] as const;

export const GOJUON_LETTERS: readonly string[] = GOJUON_ROWS.flat();

const SMALL_TO_LARGE: Record<string, string> = {
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
  "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ", "っ": "つ",
};

export function normalizeJapaneseReading(value: string): string {
  return Array.from(value.normalize("NFKD"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x30a1 && codePoint <= 0x30f6
      ? String.fromCodePoint(codePoint - 0x60)
      : character;
  }).join("").normalize("NFC").replace(/[\s\u3000]+/g, "");
}

export function getGojuonIndexLetter(reading: string): string | null {
  const normalized = normalizeJapaneseReading(reading);
  for (const character of Array.from(normalized)) {
    if (/^[\p{P}\p{S}ー…‥]+$/u.test(character)) continue;
    if (!/^[\u3040-\u309f]$/u.test(character)) return null;
    const expanded = SMALL_TO_LARGE[character] ?? character;
    const unvoiced = expanded.normalize("NFD").replace(/[\u3099\u309a]/g, "").normalize("NFC");
    return GOJUON_LETTERS.includes(unvoiced) ? unvoiced : null;
  }
  return null;
}

export function getAvailableGojuonLetters(readings: string[]): string[] {
  const available = new Set(readings.map(getGojuonIndexLetter).filter((letter): letter is string => letter !== null));
  return GOJUON_LETTERS.filter((letter) => available.has(letter));
}

const japaneseCollator = new Intl.Collator("ja", { sensitivity: "variant", numeric: true });

export function compareJapaneseReadings(left: string, right: string): number {
  const normalizedLeft = normalizeJapaneseReading(left);
  const normalizedRight = normalizeJapaneseReading(right);
  if (!normalizedLeft && normalizedRight) return 1;
  if (normalizedLeft && !normalizedRight) return -1;
  return japaneseCollator.compare(normalizedLeft, normalizedRight);
}