import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import sharp from "sharp";

import { findFinalPdfChromiumExecutable } from "../lib/local-final-pdf.ts";
import { resolveFinalPdfRendererConfig } from "../lib/final-pdf-renderer-config.ts";
import { validateBodyPdf, validateCoverPng } from "../lib/order-assets.ts";
import { calculateCoverLayout } from "../lib/production.ts";

const APP_ORIGIN = process.env.AMUHON_TEST_BASE_URL ?? "http://localhost:3000";
const WORKS = [
  { id: "000015", title: "アグニの神" },
  { id: "000055", title: "芋粥" },
  { id: "000019", title: "或阿呆の一生" },
];
const ORDER_ID = "d9d71ea0-115c-4b26-8c1d-86bead2aecc4";

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
  const localRendererConfig = resolveFinalPdfRendererConfig({
    ...process.env,
    NODE_ENV: "development",
  });
  const browser = await chromium.launch({
    executablePath: await findFinalPdfChromiumExecutable(localRendererConfig),
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ja-JP" });
  const page = await context.newPage();
  let draftRequestCount = 0;
  let uploadRequestCount = 0;
  let statusRequestCount = 0;
  let checkoutRequestCount = 0;
  let validatedBodyPageCount = null;
  let validatedCover = null;
  let bodySnapshotIncluded = false;
  let orderPdfRequestStarted = false;
  let orderPdfResponseStatus = null;
  let orderPdfResponseDiagnostic = null;

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
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/dev/order-pdf") return;
      orderPdfRequestStarted = true;
      const body = request.postDataJSON();
      bodySnapshotIncluded = Array.isArray(body?.preloadedWorks) && body.preloadedWorks.length === WORKS.length;
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/dev/order-pdf") {
        orderPdfResponseStatus = response.status();
        orderPdfResponseDiagnostic = response.headers()["x-diagnostic-code"] ?? null;
      }
    });

    await page.goto(`${APP_ORIGIN}/final`, { waitUntil: "domcontentloaded" });
    await page.getByText(/実際の組版結果です/).waitFor({ timeout: 150_000 });
    await page.getByRole("region", { name: "完成した本の内容" }).getByText("80ページ", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "注文内容を確認して進む" }).click();
    await page.waitForURL("**/order");
    await page.getByLabel("氏名").fill("ローカル試験購入者");
    await page.getByLabel("郵便番号").fill("1000001");
    await page.getByLabel("都道府県").selectOption({ label: "東京都" });
    await page.getByLabel("市区町村").fill("千代田区千代田");
    await page.getByLabel("番地・建物名").fill("1-1");
    await page.getByLabel("電話番号").fill("0312345678");
    await page.getByLabel("メールアドレス").fill("local-test@example.invalid");
    await page.getByRole("button", { name: "配送先を確認する" }).click();
    await page.getByRole("heading", { name: "本文PDFと見開きカバーを自動生成" }).waitFor();
    assert.equal(await page.locator('input[type="file"]').count(), 0, "Automatic mode must not render file pickers.");
    const orderPdfResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/dev/order-pdf", { timeout: 180_000 },
    );
    await page.getByRole("button", { name: "本を生成して確認する" }).click();
    const orderPdfResponse = await orderPdfResponsePromise;
    if (!orderPdfResponse.ok()) {
      assert.fail(`ORDER_PDF_HTTP_${orderPdfResponse.status()} diagnostic=${orderPdfResponseDiagnostic ?? "none"}`);
    }
    try {
      await page.waitForFunction(() => {
        const generated = [...document.querySelectorAll("h1, h2, h3")].some((element) => element.textContent?.trim() === "本のデータを受け取りました");
        const failed = [...document.querySelectorAll('[role="alert"]')].some((element) => element.textContent?.includes("本文PDFを作成できませんでした"));
        return generated || failed;
      }, null, { timeout: 180_000 });
    } catch {
      assert.fail(`ORDER_PDF_RESPONSE_TIMEOUT requestStarted=${orderPdfRequestStarted} responseStatus=${orderPdfResponseStatus ?? "none"}`);
    }
    const generationFailureLocator = page.locator('[role="alert"]').filter({ hasText: "本文PDFを作成できませんでした" });
    if (await generationFailureLocator.count() > 0) {
      const generationFailure = await generationFailureLocator.first().textContent() ?? "";
      const diagnosticCode = /診断コード: ([A-Z][A-Z0-9_]{2,63})/u.exec(generationFailure)?.[1] ?? "MISSING_DIAGNOSTIC_CODE";
      assert.fail(`Order-screen PDF generation failed with ${diagnosticCode}.`);
    }
    await page.getByRole("heading", { name: "本のデータを受け取りました" }).waitFor({ timeout: 10_000 });
    await page.getByText(/本の内容：確認済み/).waitFor({ timeout: 30_000 });
    await page.locator("p").filter({ hasText: "1,980" }).filter({ hasText: "税込・送料込み" }).waitFor({ timeout: 30_000 });

    assert.equal(draftRequestCount, 1);
    assert.equal(uploadRequestCount, 1);
    assert.ok(statusRequestCount >= 1);
    assert.equal(checkoutRequestCount, 0, "This proof must not start Stripe Checkout.");
    assert.equal(validatedBodyPageCount, 80);
    assert.ok(validatedCover);
    assert.equal(bodySnapshotIncluded, true, "the same approved /final body snapshot is handed to local PDF rendering");
  } finally {
    await context.close();
    await browser.close();
  }
});
