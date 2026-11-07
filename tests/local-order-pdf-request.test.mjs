import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseLocalOrderPdfRequest } from "../lib/local-order-pdf-request.ts";

const validInput = {
  book: {
    title: "試作の本",
    editor: "試作",
    coverStyle: "classic",
    coverColor: "red",
    works: [{
      id: "000015",
      title: "アグニの神",
      author: "芥川 竜之介",
      cardUrl: "https://www.aozora.gr.jp/cards/000879/card15.html",
      textUrl: "https://www.aozora.gr.jp/cards/000879/files/15_14583.txt",
      xhtmlUrl: "https://www.aozora.gr.jp/cards/000879/files/15_14583.html",
    }],
  },
  bodyPdfPageCount: 80,
};

test("accepts a bounded Aozora snapshot and preserves work order", () => {
  const parsed = parseLocalOrderPdfRequest(validInput);
  assert.equal(parsed?.bodyPdfPageCount, 80);
  assert.deepEqual(parsed?.book.works.map((work) => work.id), ["000015"]);
});

test("rejects arbitrary hosts, protocols, ports, and paths", () => {
  for (const xhtmlUrl of [
    "http://www.aozora.gr.jp/cards/000879/files/15.html",
    "https://example.com/cards/15.html",
    "https://localhost:3000/cards/15.html",
    "https://www.aozora.gr.jp:8443/cards/000879/files/15.html",
    "file:///C:/private/book.html",
  ]) {
    const input = structuredClone(validInput);
    input.book.works[0].xhtmlUrl = xhtmlUrl;
    assert.equal(parseLocalOrderPdfRequest(input), null, xhtmlUrl);
  }
});

test("rejects non-submission page counts and duplicate work IDs", () => {
  for (const bodyPdfPageCount of [0, 23, 81, 504, "80"]) {
    assert.equal(parseLocalOrderPdfRequest({ ...validInput, bodyPdfPageCount }), null);
  }
  const duplicate = structuredClone(validInput);
  duplicate.book.works.push({ ...duplicate.book.works[0], title: "別の作品" });
  assert.equal(parseLocalOrderPdfRequest(duplicate), null);
});

test("does not carry caller-supplied HTML or render URL into the accepted snapshot", () => {
  const parsed = parseLocalOrderPdfRequest({
    ...validInput,
    html: "<script>bad()</script>",
    url: "file:///C:/secret.html",
    book: { ...validInput.book, html: "<img src=x onerror=bad()>" },
  });
  assert.ok(parsed);
  assert.equal("html" in parsed.book, false);
  assert.equal("url" in parsed, false);
});

test("renderer stays development-only and uses a fixed local /final page", async () => {
  const [route, renderer, orderPage] = await Promise.all([
    readFile(new URL("../app/api/dev/order-pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/order/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /process\.env\.NODE_ENV !== "development"/);
  assert.match(route, /requestUrl\.origin !== "http:\/\/localhost:3000"/);
  assert.match(route, /origin !== "http:\/\/localhost:3000"/);
  assert.match(route, /host !== "localhost:3000"/);
  assert.match(route, /parseLocalOrderPdfRequest\(raw\)/);
  assert.match(route, /MAX_REQUEST_BYTES = 256 \* 1024/);
  assert.match(renderer, /const LOCAL_FINAL_URL = "http:\/\/localhost:3000\/final"/);
  assert.match(renderer, /preferCSSPageSize: true/);
  assert.match(renderer, /printBackground: true/);
  assert.match(orderPage, /AUTO_FILE_GENERATION_ENABLED = process\.env\.NODE_ENV === "development"/);
  assert.match(orderPage, /type="file"/);
});
