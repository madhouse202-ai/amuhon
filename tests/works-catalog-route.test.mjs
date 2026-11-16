import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { GET } from "../app/api/works/route.ts";

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test("catalog shelves use existing work metadata and preserve exact author pagination and search", async () => {
  const rows = [
    ["0001", "鼻", "芥川", "龍之介"],
    ["0002", "羅生門", "芥川", "龍之介"],
    ["0003", "芋粥", "芥川", "龍之介"],
    ["0004", "銀河鉄道の夜", "宮沢", "賢治"],
    ["0005", "注文の多い料理店", "宮沢", "賢治"],
    ["0006", "春の短い話", "", ""],
  ];
  const header = ["作品ID", "作品名", "姓", "名", "図書カードURL", "テキストファイルURL", "XHTMLファイルURL"];
  const csv = [
    header.map(csvCell).join(","),
    ...rows.map(([id, title, lastName, firstName]) => [
      id,
      title,
      lastName,
      firstName,
      `https://www.aozora.gr.jp/cards/${id}/card.html`,
      `https://www.aozora.gr.jp/cards/${id}/files/${id}_0.txt`,
      `https://www.aozora.gr.jp/cards/${id}/files/${id}_0.html`,
    ].map(csvCell).join(",")),
  ].join("\n");
  const archive = new JSZip();
  archive.file("catalog.csv", csv);
  const catalogZip = await archive.generateAsync({ type: "uint8array" });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async (input) => {
    fetchCount += 1;
    assert.equal(String(input), "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip");
    return new Response(catalogZip, { status: 200 });
  };

  try {
    const discoveryResponse = await GET(new Request("http://localhost/api/works?browse=discover"));
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.authors.length, 2);
    assert.deepEqual(new Set(discovery.authors.map((shelf) => shelf.author)), new Set(["芥川 龍之介", "宮沢 賢治"]));
    assert.ok(discovery.authors.every((shelf) => shelf.workCount === 3 || shelf.workCount === 2));
    assert.ok(discovery.authors.every((shelf) => shelf.sampleTitles.length > 0 && shelf.sampleTitles.length <= 2));
    assert.equal(discovery.works.length, rows.length);
    assert.equal(new Set(discovery.works.map((work) => work.id)).size, rows.length);
    assert.ok(discovery.works.every((work) => rows.some(([id]) => id === work.id)));

    const pageResponse = await GET(new Request("http://localhost/api/works?browse=author&author=%E8%8A%A5%E5%B7%9D%20%E9%BE%8D%E4%B9%8B%E4%BB%8B&offset=0"));
    const authorPage = await pageResponse.json();
    assert.equal(pageResponse.status, 200);
    assert.equal(authorPage.total, 3);
    assert.equal(authorPage.nextOffset, 3);
    assert.equal(authorPage.hasMore, false);
    assert.deepEqual(authorPage.works.map((work) => work.title), ["鼻", "羅生門", "芋粥"]);

    const searchResponse = await GET(new Request("http://localhost/api/works?q=%E7%BE%85%E7%94%9F%E9%96%80"));
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.deepEqual(search.works.map((work) => work.title), ["羅生門"]);

    const invalidAuthorResponse = await GET(new Request("http://localhost/api/works?browse=author&author=x&offset=-1"));
    assert.equal(invalidAuthorResponse.status, 400);
    assert.equal(fetchCount, 1, "Browse and search should share the in-memory public catalog cache.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
