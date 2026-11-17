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
    ["0008", "未分類の本", "架空", "作者", "著者", "", "", "", ""],
  ];
  for (let index = 0; index < 52; index += 1) {
    rows.push([`1${String(index).padStart(4, "0")}`, `作品${String(index).padStart(2, "0")}`, "あ作者", String(index), "著者", "あ", "さくしゃ", `あ作品${index}`, `あさくひん${index}`]);
  }
  rows.push(["9999", "桃太郎", "茂木", "一郎", "著者", "もぎ", "いちろう", "ももたろう", "ももたろう"]);
  const header = ["作品ID", "作品名", "姓", "名", "役割フラグ", "姓読み", "名読み", "作品名読み", "ソート用読み", "図書カードURL", "テキストファイルURL", "XHTMLファイルURL"];
  const csv = [
    header.map(csvCell).join(","),
    ...rows.map(([id, title, lastName, firstName, role, lastNameReading, firstNameReading, titleReading = "", sortReading = ""]) => [
      id, title, lastName, firstName, role, lastNameReading, firstNameReading, titleReading, sortReading,
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
    assert.equal(discovery.authors.length, 12, "author shelf remains capped");
    assert.ok(discovery.authors.every((shelf) => shelf.workCount >= 1));
    assert.ok(discovery.authors.every((shelf) => shelf.sampleTitles.length > 0 && shelf.sampleTitles.length <= 2));
    assert.equal(discovery.works.length, 24, "discovery sends only a bounded random shelf");
    assert.equal(new Set(discovery.works.map((work) => work.id)).size, discovery.works.length);
    assert.ok(discovery.works.every((work) => rows.some(([id]) => id === work.id)));
    const oshidoriResponse = await GET(new Request("http://localhost/api/works?q=%E3%81%8A%E3%81%97%E3%81%A9%E3%82%8A"));
    const oshidori = (await oshidoriResponse.json()).works.find((work) => work.id === "0007");
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
    assert.equal(authorList.authors.length, 50);
    assert.ok(authorList.availableLetters.includes("あ"));
    assert.ok(authorList.availableLetters.includes("も"));
    assert.equal(authorList.authors.some((entry) => entry.author === "茂木 一郎"), false, "the later author is beyond the first page");
    const unindexedAuthorPage = await GET(new Request("http://localhost/api/works?browse=authors&offset=56"));
    assert.equal((await unindexedAuthorPage.json()).authors[0]?.author, "架空 作者", "entries without CSV readings remain available in All");
    const authorByKanaResponse = await GET(new Request("http://localhost/api/works?browse=authors&letter=%E3%82%82&offset=0"));
    const authorByKana = await authorByKanaResponse.json();
    assert.equal(authorByKanaResponse.status, 200);
    assert.ok(authorByKana.authors.some((entry) => entry.author === "茂木 一郎"), "kana index jumps to an author beyond the unloaded page");
    assert.equal(authorByKana.total, 1);

    const workListResponse = await GET(new Request("http://localhost/api/works?browse=works&offset=0"));
    const workList = await workListResponse.json();
    assert.equal(workList.works.length, 40);
    assert.equal(workList.works.some((work) => work.id === "9999"), false, "the later work is beyond the first page");
    assert.ok(workList.availableLetters.includes("も"));
    const workByKanaResponse = await GET(new Request("http://localhost/api/works?browse=works&letter=%E3%82%82&offset=0"));
    const workByKana = await workByKanaResponse.json();
    assert.equal(workByKanaResponse.status, 200);
    assert.deepEqual(workByKana.works.map((work) => work.id), ["9999"], "kana index jumps to a work beyond the unloaded page");
    assert.equal(workByKana.total, 1);
    assert.equal((await GET(new Request("http://localhost/api/works?browse=works&letter=%E3%82%94"))).status, 400);

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
