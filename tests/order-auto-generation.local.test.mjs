import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";
import sharp from "sharp";

import { validateBodyPdf, validateCoverPng } from "../lib/order-assets.ts";
import { calculateCoverLayout } from "../lib/production.ts";

const APP_ORIGIN = "http://localhost:3000";
const WORKS = [
  { id: "000015", title: "アグニの神" },
  { id: "000055", title: "芋粥" },
  { id: "000019", title: "或阿呆の一生" },
];
const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";

const BROWSER_EXECUTABLES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

async function findBrowserExecutable() {
  for (const executablePath of BROWSER_EXECUTABLES) {
    try {
      await access(executablePath);
      return executablePath;
    } catch {
      // Only standard local browser locations are considered.
    }
  }
  throw new Error("A standard local Chrome or Edge installation is required.");
}

async function loadSelectedWorks() {
  const works = [];
  for (const expected of WORKS) {
    const response = await fetch(`${APP_ORIGIN}/api/works?q=${encodeURIComponent(expected.title)}`, {
      signal: AbortSignal.timeout(90_000),
      cache: "no-store",
    });
    assert.equal(response.ok, true, "The local work catalog must be available.");
    const result = await response.json();
    const matches = Array.isArray(result.works)
      ? result.works.filter((work) => work?.id === expected.id && work?.title === expected.title)
      : [];
    assert.equal(matches.length, 1, "The selected Aozora work must match the local catalog.");
    works.push(matches[0]);
  }
  return works;
}

function extractMultipartFile(request, fieldName) {
  const contentType = request.headers()["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  const body = request.postDataBuffer();
  assert.ok(boundary && body, "The existing upload API must receive multipart files.");
  const fieldMarker = Buffer.from(`name="${fieldName}"`);
  const fieldOffset = body.indexOf(fieldMarker);
  assert.notEqual(fieldOffset, -1, `Missing ${fieldName} upload part.`);
  const payloadStart = body.indexOf(Buffer.from("\r\n\r\n"), fieldOffset);
  assert.notEqual(payloadStart, -1, "Malformed multipart file part.");
  const payloadOffset = payloadStart + 4;
  const payloadEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), payloadOffset);
  assert.notEqual(payloadEnd, -1, "Unterminated multipart file part.");
  return new Uint8Array(body.subarray(payloadOffset, payloadEnd));
}

test("local order UI generates and validates both assets without file selection", { timeout: 360_000 }, async () => {
  const works = await loadSelectedWorks();
  const book = {
    works,
    title: "注文フロー試作",
    editor: "ローカル検証",
    coverStyle: "classic",
    coverColor: "red",
  };
  const browser = await chromium.launch({ executablePath: await findBrowserExecutable(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ja-JP" });
  const page = await context.newPage();
  let draftRequestCount = 0;
  let uploadRequestCount = 0;
  let statusRequestCount = 0;
  let checkoutRequestCount = 0;
  let validatedBodyPageCount = null;
  let validatedCover = null;

  try {
    await page.addInitScript((selectedBook) => {
      localStorage.setItem("amuhon-book", JSON.stringify(selectedBook));
    }, book);

    await page.route("**/api/orders**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/orders" && request.method() === "POST") {
        draftRequestCount += 1;
        const body = request.postDataJSON();
        assert.equal(body.declaredBodyPdfPageCount, 80);
        assert.deepEqual(body.book.works.map((work) => work.id), WORKS.map((work) => work.id));
        await route.fulfill({ json: {
          order: { id: ORDER_ID, status: "draft", createdAt: "2026-11-07T00:00:00.000Z" },
        } });
        return;
      }
      if (url.pathname === `/api/orders/${ORDER_ID}/files` && request.method() === "POST") {
        uploadRequestCount += 1;
        const bodyPdfBytes = extractMultipartFile(request, "bodyPdf");
        const coverPngBytes = extractMultipartFile(request, "coverPng");
        const body = await validateBodyPdf(bodyPdfBytes);
        validatedBodyPageCount = body.pageCount;
        validatedCover = await validateCoverPng(coverPngBytes, body.pageCount);
        const expectedCover = calculateCoverLayout(body.pageCount);
        assert.equal(validatedCover.width, expectedCover.pixelWidth);
        assert.equal(validatedCover.height, expectedCover.pixelHeight);
        const { data: pixels, info } = await sharp(Buffer.from(coverPngBytes))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const pixelAt = (x, y) => {
          const offset = (y * info.width + x) * info.channels;
          return [...pixels.subarray(offset, offset + 3)];
        };
        const pixelsPerMm = info.width / expectedCover.coverWidthMm;
        const framePixel = pixelAt(Math.round(9 * pixelsPerMm), Math.round(20 * pixelsPerMm));
        assert.ok(framePixel[0] > 230 && framePixel[1] > 220 && framePixel[2] > 200,
          "The classic frame should remain at its intended front-cover position.");
        const lowerRightHorizontalArtifact = pixelAt(Math.round(info.width * 0.9), Math.round(info.height * 0.82));
        const lowerRightVerticalArtifact = pixelAt(Math.round(info.width * 0.56), Math.round(info.height * 0.9));
        for (const pixel of [lowerRightHorizontalArtifact, lowerRightVerticalArtifact]) {
          assert.ok(pixel[0] < 210 && pixel[1] < 100 && pixel[2] < 100,
            "The unintended white lower-right frame must not be present.");
        }
        await route.fulfill({ json: { order: { status: "preparing", bodyPdfPageCount: body.pageCount } } });
        return;
      }
      if (url.pathname === `/api/orders/${ORDER_ID}/status` && request.method() === "GET") {
        statusRequestCount += 1;
        await route.fulfill({ json: {
          status: "ready_for_payment",
          pageCount: 80,
          filesVerified: true,
          quotedAmountYen: 1980,
          canCheckout: true,
          checkoutState: "not_started",
        } });
        return;
      }
      if (url.pathname === `/api/orders/${ORDER_ID}/checkout`) checkoutRequestCount += 1;
      await route.abort("blockedbyclient");
      throw new Error("Unexpected order API request was blocked.");
    });

    await page.goto(`${APP_ORIGIN}/final`, { waitUntil: "domcontentloaded" });
    await page.getByText(/実組版結果：/).waitFor({ timeout: 150_000 });
    await page.getByText(/本文PDF 80 ページ|本文PDF 80ページ/).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "注文手続きへ" }).click();
    await page.waitForURL("**/order");
    await page.getByLabel("氏名").fill("ローカル試験購入者");
    await page.getByLabel("郵便番号").fill("1000001");
    await page.getByLabel("都道府県").selectOption({ label: "東京都" });
    await page.getByLabel("市区町村").fill("千代田区千代田");
    await page.getByLabel("番地・建物名").fill("1-1");
    await page.getByLabel("電話番号").fill("0312345678");
    await page.getByLabel("メールアドレス").fill("local-test@example.invalid");
    await page.getByRole("button", { name: "入力内容を確認する" }).click();

    const automaticOption = page.getByRole("radio", { name: /この画面で自動生成する/ });
    await automaticOption.check();
    assert.equal(await page.locator('input[type="file"]').count(), 0, "Automatic mode must not render file pickers.");
    await page.getByRole("button", { name: "本を生成して検証・保存する" }).click();
    await page.getByRole("heading", { name: "注文下書きと入稿ファイルを保存しました" }).waitFor({ timeout: 180_000 });
    await page.locator("p").filter({ hasText: "状態：ready_for_payment" }).filter({ hasText: "ファイル検証済み" }).waitFor({ timeout: 30_000 });
    await page.locator("p").filter({ hasText: "1,980" }).filter({ hasText: "税込・送料込み" }).waitFor({ timeout: 30_000 });

    assert.equal(draftRequestCount, 1);
    assert.equal(uploadRequestCount, 1);
    assert.ok(statusRequestCount >= 1);
    assert.equal(checkoutRequestCount, 0, "This proof must not start Stripe Checkout.");
    assert.equal(validatedBodyPageCount, 80);
    assert.ok(validatedCover);
  } finally {
    await context.close();
    await browser.close();
  }
});
