import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderLocalFinalBodyPdf } from "../lib/local-final-pdf.ts";

const APP_ORIGIN = "http://localhost:3000";
const WORKS_TO_RENDER = [
  { id: "000015", title: "アグニの神" },
  { id: "000055", title: "芋粥" },
  { id: "000019", title: "或阿呆の一生" },
];
const LEGACY_EXPECTED_PAGE_COUNT = 80;
const OUTPUT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tmp/final-pdf-poc",
);

async function loadWorks() {
  const works = [];
  for (const { id, title } of WORKS_TO_RENDER) {
    let response;
    try {
      response = await fetch(
        `${APP_ORIGIN}/api/works?q=${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(90_000), cache: "no-store" },
      );
    } catch {
      throw new Error("Could not reach the local app catalog. Start npm run dev and retry.");
    }
    if (!response.ok) throw new Error(`The local catalog request failed with HTTP ${response.status}.`);
    const result = await response.json();
    const matches = Array.isArray(result.works)
      ? result.works.filter((work) => work?.id === id && work?.title === title)
      : [];
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one Aozora catalog entry for ${title}; found ${matches.length}.`);
    }
    works.push(matches[0]);
  }
  return works;
}

async function main() {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const book = {
    works: await loadWorks(),
    title: "PDF自動生成試作",
    editor: "試作",
    coverStyle: "classic",
    coverColor: "red",
  };
  const result = await renderLocalFinalBodyPdf(book, LEGACY_EXPECTED_PAGE_COUNT, {
    includeVisualSample: true,
    requireRubyNodes: true,
  });
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const pdfPath = path.join(OUTPUT_DIRECTORY, `body-three-works-${timestamp}.pdf`);
  const visualSamplePath = path.join(OUTPUT_DIRECTORY, `ruby-layout-sample-${timestamp}.png`);
  await writeFile(pdfPath, result.pdfBytes);
  if (result.visualSample) await writeFile(visualSamplePath, result.visualSample);

  console.log("PDF generation: PASS");
  console.log(`Works: ${book.works.map((work) => work.title).join("、")}`);
  console.log(`PDF pages: ${result.pageCount} (legacy 80-page comparison: ${result.pageCount === LEGACY_EXPECTED_PAGE_COUNT ? "MATCH" : "DIFFERENT"})`);
  console.log("PDF page size, crop box, and rotation: A6 portrait on every page (existing order validator PASS)");
  console.log(`Vertical-writing ruby DOM nodes: ${result.rubyCount}`);
  console.log(`PDF: ${pdfPath}`);
  if (result.visualSample) console.log(`Visual sample: ${visualSamplePath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unexpected PDF proof failure.";
  console.error(`PDF generation: FAIL — ${message}`);
  process.exitCode = 1;
});
