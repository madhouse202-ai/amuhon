import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";

const baseURL = process.env.AMUHON_TEST_BASE_URL;
const executablePath = process.env.AMUHON_TEST_CHROMIUM || [
  process.env.ProgramFiles && `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  chromium.executablePath(),
].filter(Boolean).find((path) => existsSync(path));

const translatorWork = {
  id: "0007",
  title: "おしどり",
  author: "小泉 八雲",
  contributors: [
    { name: "小泉 八雲", role: "著者", reading: "こいずみ やくも" },
    { name: "田部 隆次", role: "翻訳者", reading: "たべ りゅうじ" },
  ],
  cardUrl: "https://www.aozora.gr.jp/cards/0007/card.html",
  textUrl: "https://www.aozora.gr.jp/cards/0007/files/0007_0.txt",
  xhtmlUrl: "https://www.aozora.gr.jp/cards/0007/files/0007_0.html",
};
const longNameWork = {
  id: "0008",
  title: "長い名前の表示試験",
  author: "表示試験用のとても長い著者名",
  contributors: [{ name: "表示試験用のとても長い著者名", role: "著者", reading: "ひょうじしけんようのとてもながいちょしゃめい" }],
  cardUrl: "https://www.aozora.gr.jp/cards/0008/card.html",
  textUrl: "https://www.aozora.gr.jp/cards/0008/files/0008_0.txt",
  xhtmlUrl: "https://www.aozora.gr.jp/cards/0008/files/0008_0.html",
};
const indexedWork = {
  id: "9999",
  title: "桃太郎",
  author: "茂木 一郎",
  contributors: [{ name: "茂木 一郎", role: "著者", reading: "もぎ いちろう" }],
  cardUrl: "https://www.aozora.gr.jp/cards/9999/card.html",
  textUrl: "https://www.aozora.gr.jp/cards/9999/files/9999_0.txt",
  xhtmlUrl: "https://www.aozora.gr.jp/cards/9999/files/9999_0.html",
};

test("bookshelf, kana index, translator details, and spine layout work on desktop and mobile", {
  skip: !baseURL || !executablePath ? "Set AMUHON_TEST_BASE_URL and AMUHON_TEST_CHROMIUM for local browser coverage." : false,
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const requestedLists = [];
      await page.route("**/api/works**", async (route) => {
        const url = new URL(route.request().url());
        const browse = url.searchParams.get("browse");
        const letter = url.searchParams.get("letter");
        if (browse === "discover") {
          await route.fulfill({ json: { authors: [], works: [translatorWork, longNameWork] } });
        } else if (browse === "authors") {
          requestedLists.push({ browse, letter });
          const authors = letter === "も" ? [{ author: "茂木 一郎", workCount: 1, sampleTitles: ["桃太郎"] }] : [{ author: "小泉 八雲", workCount: 1, sampleTitles: ["おしどり"] }];
          await route.fulfill({ json: { authors, total: authors.length, nextOffset: authors.length, hasMore: false, availableLetters: ["こ", "も"] } });
        } else if (browse === "works") {
          requestedLists.push({ browse, letter });
          const works = letter === "も" ? [indexedWork] : [translatorWork];
          await route.fulfill({ json: { works, total: works.length, nextOffset: works.length, hasMore: false, availableLetters: ["こ", "も"] } });
        } else if (browse === "author") {
          await route.fulfill({ json: { author: url.searchParams.get("author"), works: [indexedWork], total: 1, nextOffset: 1, hasMore: false } });
        } else if (url.searchParams.has("q")) {
          await route.fulfill({ json: { works: [translatorWork] } });
        } else {
          await route.fulfill({ status: 400, json: { error: "unexpected_mock_request" } });
        }
      });
      await page.route("**/api/aozora**", (route) => route.fulfill({ json: { pageCount: 1 } }));

      await page.goto(`${baseURL}/create`);
      const spine = page.locator('button[aria-label^="おしどり、小泉 八雲"]');
      await spine.waitFor();
      assert.match(await spine.getAttribute("aria-label"), /小泉 八雲/);
      const authorOnSpine = spine.locator('[title="小泉 八雲"]');
      assert.equal(await authorOnSpine.evaluate((element) => getComputedStyle(element).writingMode), "vertical-rl");
      assert.equal(await authorOnSpine.evaluate((element) => getComputedStyle(element).whiteSpace), "nowrap");
      const longSpine = page.locator('button[aria-label^="長い名前の表示試験"]');
      await longSpine.waitFor();
      assert.match(await longSpine.getAttribute("aria-label"), /表示試験用のとても長い著者名/);
      const longAuthor = longSpine.locator('[title="表示試験用のとても長い著者名"]');
      assert.equal(await longAuthor.evaluate((element) => getComputedStyle(element).whiteSpace), "nowrap");
      assert.equal(await longAuthor.evaluate((element) => getComputedStyle(element).fontSize), "8px");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow at ${viewport.width}px`);

      await spine.click();
      const detail = page.getByRole("dialog");
      await detail.getByText("著者：小泉 八雲").waitFor();
      await detail.getByText("翻訳者：田部 隆次").waitFor();
      await detail.getByRole("button", { name: "この作品を本に追加" }).click();
      await detail.getByText("この作品は本に入っています").waitFor();
      await detail.getByRole("button", { name: "作品詳細を閉じる" }).click();
      assert.equal(await spine.getAttribute("aria-pressed"), "true", "added work stays visible and selected on its shelf");

      await page.getByRole("button", { name: "作家一覧", exact: true }).click();
      await page.getByRole("button", { name: "小泉 八雲", exact: false }).waitFor();
      assert.equal(await page.getByText("あ行", { exact: true }).count(), 0, "row labels should stay visually hidden");
      assert.ok(await page.locator('[role="group"][aria-label="あ行"]').count(), "row context stays available to assistive technology");
      const unavailableAuthorKana = page.getByRole("button", { name: "あから始まる作家一覧" });
      assert.equal(await unavailableAuthorKana.isDisabled(), true);
      await page.getByRole("button", { name: "もから始まる作家一覧" }).click();
      const authorResult = page.getByRole("button", { name: /茂木 一郎/ });
      await authorResult.waitFor();
      assert.ok(requestedLists.some((entry) => entry.browse === "authors" && entry.letter === "も"));
      const authorHeading = page.getByRole("heading", { name: "茂木 一郎" });
      await authorHeading.waitFor();
      await page.waitForFunction(() => {
        const heading = [...document.querySelectorAll("h3")].find((element) => element.textContent === "茂木 一郎");
        return heading !== undefined && heading.getBoundingClientRect().top >= 0 && heading.getBoundingClientRect().top < window.innerHeight / 3;
      });
      assert.equal(await authorHeading.evaluate((element) => document.activeElement === element), true,
        "author result heading receives focus after loading for keyboard users");

      await page.getByRole("button", { name: "作品一覧", exact: true }).click();
      const unavailableWorkKana = page.getByRole("button", { name: "あから始まる作品一覧" });
      assert.equal(await unavailableWorkKana.isDisabled(), true);
      await page.getByRole("button", { name: "もから始まる作品一覧" }).click();
      await page.getByText("桃太郎", { exact: true }).first().waitFor();
      assert.ok(requestedLists.some((entry) => entry.browse === "works" && entry.letter === "も"));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `index overflows at ${viewport.width}px`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
