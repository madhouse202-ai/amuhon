import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";
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

test("renderer config keeps local defaults and fails closed outside development", () => {
  const local = resolveFinalPdfRendererConfig({ NODE_ENV: "development" }, "win32");
  assert.equal(local.renderUrl, "http://localhost:3000/final");
  assert.equal(local.renderOrigin, "http://localhost:3000");
  assert.equal(local.executableCandidates.length, 3);

  assert.throws(
    () => resolveFinalPdfRendererConfig({ NODE_ENV: "production" }, "linux"),
    /Chromium実行パスが設定されていません/,
  );
  assert.throws(
    () => resolveFinalPdfRendererConfig({
      NODE_ENV: "production",
      ORDER_PDF_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
    }, "linux"),
    /内部URLが設定されていません/,
  );
});

test("production renderer requires an absolute Chromium path and loopback /final URL", () => {
  const accepted = resolveFinalPdfRendererConfig({
    NODE_ENV: "production",
    ORDER_PDF_CHROMIUM_EXECUTABLE_PATH: "C:\\renderer\\chromium.exe",
    ORDER_PDF_RENDER_URL: "http://127.0.0.1:3100/final",
  }, "win32");
  assert.equal(accepted.renderUrl, "http://127.0.0.1:3100/final");
  assert.deepEqual(accepted.executableCandidates, ["C:\\renderer\\chromium.exe"]);

  for (const renderUrl of [
    "https://example.com/final",
    "http://192.168.1.2:3100/final",
    "http://localhost/final",
    "http://localhost:3100/other",
    "http://user:pass@localhost:3100/final",
    "http://localhost:3100/final?url=https://example.com",
  ]) {
    assert.throws(() => resolveFinalPdfRendererConfig({
      NODE_ENV: "production",
      ORDER_PDF_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
      ORDER_PDF_RENDER_URL: renderUrl,
    }, "linux"), /loopbackの\/final/);
  }

  assert.throws(() => resolveFinalPdfRendererConfig({
    NODE_ENV: "production",
    ORDER_PDF_CHROMIUM_EXECUTABLE_PATH: "relative/chromium",
    ORDER_PDF_RENDER_URL: "http://127.0.0.1:3100/final",
  }, "linux"), /絶対パス/);
});

test("renderer stays development-only at its API and seeds only the isolated render origin", async () => {
  const [route, renderer, rendererConfig, orderPage] = await Promise.all([
    readFile(new URL("../app/api/dev/order-pdf/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-final-pdf.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/final-pdf-renderer-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/order/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /process\.env\.NODE_ENV !== "development"/);
  assert.match(route, /requestUrl\.origin !== "http:\/\/localhost:3000"/);
  assert.match(route, /origin !== "http:\/\/localhost:3000"/);
  assert.match(route, /host !== "localhost:3000"/);
  assert.match(route, /parseLocalOrderPdfRequest\(raw\)/);
  assert.match(route, /MAX_REQUEST_BYTES = 256 \* 1024/);
  assert.match(renderer, /resolveFinalPdfRendererConfig\(\)/);
  assert.match(renderer, /location\.origin === renderOrigin/);
  assert.match(renderer, /page\.goto\(rendererConfig\.renderUrl/);
  assert.match(rendererConfig, /ORDER_PDF_CHROMIUM_EXECUTABLE_PATH/);
  assert.match(rendererConfig, /ORDER_PDF_RENDER_URL/);
  assert.match(rendererConfig, /url\.pathname !== "\/final"/);
  assert.doesNotMatch(renderer, /http:\/\/localhost:3000\/final/);
  assert.match(renderer, /preferCSSPageSize: true/);
  assert.match(renderer, /printBackground: true/);
  assert.match(orderPage, /AUTO_FILE_GENERATION_ENABLED = process\.env\.NODE_ENV === "development"/);
  assert.match(orderPage, /type="file"/);
});
