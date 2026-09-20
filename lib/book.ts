export type CoverStyle = "classic" | "free";
export type CoverColor = "red" | "blue" | "green";

export type BookData = {
  works: string[];
  title: string;
  editor: string;
  coverStyle: CoverStyle;
  coverColor: CoverColor;
};

export const defaultBookData: BookData = {
  works: [],
  title: "わたしの本",
  editor: "編者",
  coverStyle: "classic",
  coverColor: "red",
};

const STORAGE_KEY = "amuhon-book";

export function saveBookData(data: BookData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadBookData(): BookData {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (!saved) {
    return defaultBookData;
  }

  try {
    return {
      ...defaultBookData,
      ...JSON.parse(saved),
    };
  } catch {
    return defaultBookData;
  }
}