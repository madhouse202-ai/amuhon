import assert from "node:assert/strict";
import test from "node:test";
import {
  compareJapaneseReadings,
  getAvailableGojuonLetters,
  getGojuonIndexLetter,
  GOJUON_LETTERS,
  normalizeJapaneseReading,
} from "../lib/kana-index.ts";

test("Japanese readings normalize katakana, half-width forms, and voiced kana for index lookup", () => {
  assert.equal(normalizeJapaneseReading("ｶﾀｶﾅ"), "かたかな");
  assert.equal(normalizeJapaneseReading("テスト"), "てすと");
  assert.equal(getGojuonIndexLetter("「ガラス」"), "か");
  assert.equal(getGojuonIndexLetter("パンダ"), "は");
  assert.equal(getGojuonIndexLetter("ヴェルヌ"), "う");
  assert.equal(getGojuonIndexLetter("ヷ"), "わ");
  assert.equal(getGojuonIndexLetter("っぽい"), "つ");
  assert.equal(getGojuonIndexLetter("ー蜜柑"), null, "kanji is not guessed from its code point");
  assert.equal(getGojuonIndexLetter("蜜柑"), null, "unreadable catalog entries stay unindexed");
});

test("the index follows standard gojuon order and deduplicates available letters", () => {
  assert.equal(GOJUON_LETTERS.length, 46);
  assert.deepEqual(getAvailableGojuonLetters(["かき", "ガラス", "はな", "パンダ", "蜜柑"]), ["か", "は"]);
  assert.ok(compareJapaneseReadings("あくたがわ りゅうのすけ", "こいずみ やくも") < 0);
  assert.ok(compareJapaneseReadings("こいずみ やくも", "みやざわ けんじ") < 0);
});