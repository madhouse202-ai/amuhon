import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { GET } from "../app/api/works/route.ts";

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test("catalog shelves use existing work metadata and preserve exact author pagination and search", async () => {
  const rows = [
    ["0001", "鼻", "芥川", "龍之介", "著者", "あくたがわ", "りゅうのすけ"],
    ["0002", "羅生門", "芥川", "龍之介", "著者", "あくたがわ", "りゅうのすけ"],
    ["0003", "芋粥", "芥川", "龍之介", "著者", "あくたがわ", "りゅうのすけ"],
    ["0004", "銀河鉄道の夜", "宮沢", "賢治", "著者", "みやざわ", "けんじ"],
    ["0005", "注文の多い料理店", "宮沢", "賢治", "著者", "みやざわ", "けんじ"],
    ["0006", "春の短い話", "", "", "著者", "", ""],
    ["0007", "おしどり", "小泉", "八雲", "著者", "こいずみ", "やくも"],
    ["0007", "おしどり", "田部", "隆次", "翻訳者", "たべ", "りゅうじ"],
  ];
  const header = ["作品ID", "作品名", "姓", "名", "役割フラグ", "姓読み", "名読み", "図書カードURL", "テキストファイルURL", "XHTMLファイルURL"];
  const csv = [
    header.map(csvCell).join(","),
    ...rows.map(([id, title, lastName, firstName, role, lastNameReading, firstNameReading]) => [
      id, title, lastName, firstName, role, lastNameReading, firstNameReading,
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
    assert.equal(discovery.authors.length, 3);
    assert.deepEqual(new Set(discovery.authors.map((shelf) => shelf.author)), new Set(["芥川 龍之介", "宮沢 賢治", "小泉 八雲"]));
    assert.ok(discovery.authors.every((shelf) => shelf.workCount >= 1));
    assert.ok(discovery.authors.every((shelf) => shelf.sampleTitles.length > 0 && shelf.sampleTitles.length <= 2));
    assert.equal(discovery.works.length, rows.length - 1, "duplicate contributor rows are folded into one work");
    assert.equal(new Set(discovery.works.map((work) => work.id)).size, rows.length - 1);
    assert.ok(discovery.works.every((work) => rows.some(([id]) => id === work.id)));
    const oshidori = discovery.works.find((work) => work.id === "0007");
    assert.equal(oshidori.author, "小泉 八雲");
    assert.ok(oshidori.contributors.some((person) => person.role === "翻訳者" && person.name === "田部 隆次"));

    const pageResponse = await GET(new Request("http://localhost/api/works?browse=author&author=%E8%8A%A5%E5%B7%9D%20%E9%BE%8D%E4%B9%8B%E4%BB%8B&offset=0"));
    const authorPage = await pageResponse.json();
    assert.equal(pageResponse.status, 200);
    assert.equal(authorPage.total, 3);
    assert.equal(authorPage.nextOffset, 3);
    assert.equal(authorPage.hasMore, false);
    assert.deepEqual(authorPage.works.map((work) => work.title), ["鼻", "羅生門", "芋粥"]);

    const authorListResponse = await GET(new Request("http://localhost/api/works?browse=authors&offset=0"));
    const authorList = await authorListResponse.json();
    assert.equal(authorListResponse.status, 200);
    assert.equal(authorList.authors.some((entry) => entry.author === "田部 隆次"), false, "translators are not exposed as authors");
    assert.deepEqual(authorList.authors.map((entry) => entry.author), ["芥川 龍之介", "小泉 八雲", "宮沢 賢治"]);

    const translatedAuthorResponse = await GET(new Request("http://localhost/api/works?browse=author&author=%E5%B0%8F%E6%B3%89%20%E5%85%AB%E9%9B%B2&offset=0"));
    const translatedAuthor = await translatedAuthorResponse.json();
    assert.deepEqual(translatedAuthor.works.map((work) => work.title), ["おしどり"]);

    const otherShelfResponse = await GET(new Request("http://localhost/api/works?browse=discover&exclude=0001"));
    const otherShelf = await otherShelfResponse.json();
    assert.equal(otherShelfResponse.status, 200);
    assert.equal(otherShelf.works.some((work) => work.id === "0001"), false);
    assert.equal(new Set(otherShelf.works.map((work) => work.id)).size, otherShelf.works.length);

    const exhaustedShelfResponse = await GET(new Request("http://localhost/api/works?browse=discover&exclude=0001%2C0002%2C0003%2C0004%2C0005%2C0006%2C0007"));
    const exhaustedShelf = await exhaustedShelfResponse.json();
    assert.equal(exhaustedShelfResponse.status, 200);
    assert.equal(new Set(exhaustedShelf.works.map((work) => work.id)).size, exhaustedShelf.works.length);

    const searchResponse = await GET(new Request("http://localhost/api/works?q=%E7%BE%85%E7%94%9F%E9%96%80"));
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.deepEqual(search.works.map((work) => work.title), ["羅生門"]);

    const translatorSearchResponse = await GET(new Request("http://localhost/api/works?q=%E7%94%B0%E9%83%A8%E9%9A%86%E6%AC%A1"));
    const translatorSearch = await translatorSearchResponse.json();
    assert.deepEqual(translatorSearch.works.map((work) => work.title), ["おしどり"]);

    const invalidAuthorResponse = await GET(new Request("http://localhost/api/works?browse=author&author=x&offset=-1"));
    assert.equal(invalidAuthorResponse.status, 400);
    assert.equal(fetchCount, 1, "Browse and search should share the in-memory public catalog cache.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
