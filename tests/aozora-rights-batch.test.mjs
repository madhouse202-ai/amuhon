import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";

import {
  AOZORA_BATCH_APPROVAL_STATEMENT,
  calculateReviewPackageSha256,
  classifyAozoraCatalog,
  classifyAozoraRightsWork,
  createAozoraRightsReviewPackage,
  generateAozoraRightsRegistrationSql,
} from "../lib/aozora-rights-review.ts";
import { resolveAozoraRightsCatalog, resolveAozoraWorkEditions } from "../lib/aozora-edition.ts";

const ROOT = new URL("../", import.meta.url);

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

const headers = [
  "作品ID", "作品名", "作品名読み", "ソート用読み", "初出", "作品著作権フラグ", "図書カードURL", "人物ID",
  "姓", "名", "姓読み", "名読み", "役割フラグ", "人物著作権フラグ", "底本名1", "底本出版社名1",
  "入力者", "校正者", "テキストファイルURL", "XHTML/HTMLファイルURL",
];

function row({
  id = "000799", title = "夢十夜", workFlag = "なし", personFlag = "なし", personId = "000148",
  titleReading = title, sortReading = title,
  family = "夏目", given = "漱石", role = "著者", firstPublication = "", baseText = "夏目漱石全集10",
  textUrl = "https://www.aozora.gr.jp/cards/000148/files/799_ruby_6024.zip",
  xhtmlUrl = "https://www.aozora.gr.jp/cards/000148/files/799_14972.html",
  cardUrl = "https://www.aozora.gr.jp/cards/000148/card799.html",
} = {}) {
  return [id, title, titleReading, sortReading, firstPublication, workFlag, cardUrl, personId, family, given, "なつめ", "そうせき", role, personFlag, baseText, "筑摩書房", "入力者", "校正者", textUrl, xhtmlUrl];
}

function fixtureWork(overrides = {}) {
  return {
    id: "000799", title: "夢十夜", titleReading: "ゆめじゅうや", sortReading: "ゆめじゅうや",
    author: "夏目 漱石", cardUrl: "https://www.aozora.gr.jp/cards/000148/card799.html",
    textUrl: "https://www.aozora.gr.jp/cards/000148/files/799_ruby_6024.zip",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/799_14972.html",
    contributors: [{ name: "夏目 漱石", role: "著者", reading: "なつめ そうせき", personIds: ["000148"], copyrightFlags: ["なし"], missingCopyrightFlagRows: 0 }],
    sourceMetadata: { firstPublication: "初出", baseText: "全集", basePublisher: "出版社", inputter: "入力者", proofreader: "校正者" },
    workCopyrightFlags: ["なし"], missingWorkCopyrightFlagRows: 0, catalogPersonCopyrightFlags: ["なし"],
    missingPersonCopyrightFlagRows: 0, incompleteContributorRows: 0,
    sourceMetadataConflicts: [], catalogIssues: [], catalogRowCount: 1,
    ...overrides,
  };
}

test("official catalog parser aggregates rows by header and uses exact flag values", async () => {
  const csv = [
    headers.map(csvCell).join(","),
    row({ firstPublication: '雑誌 "新潮",\n1910年' }).map(csvCell).join(","),
    row({ id: "000800", title: "翻訳作品", workFlag: "なし", personId: "000148", family: "夏目", given: "漱石", role: "著者", textUrl: "https://www.aozora.gr.jp/cards/000148/files/800_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/800_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card800.html" }).map(csvCell).join(","),
    row({ id: "000800", title: "翻訳作品", workFlag: "なし", personId: "000900", family: "翻訳", given: "者", role: "翻訳者", personFlag: "なし", textUrl: "https://www.aozora.gr.jp/cards/000148/files/800_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/800_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card800.html" }).map(csvCell).join(","),
    row({ id: "000801", title: "保護作品", workFlag: "あり", personFlag: "あり", textUrl: "https://www.aozora.gr.jp/cards/000148/files/801_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/801_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card801.html" }).map(csvCell).join(","),
    row({ id: "000802", title: "フラグ不明", workFlag: "不明", textUrl: "https://www.aozora.gr.jp/cards/000148/files/802_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/802_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card802.html" }).map(csvCell).join(","),
    row({ id: "000803", title: "読み矛盾", titleReading: "よみいち", sortReading: "よみいち", textUrl: "https://www.aozora.gr.jp/cards/000148/files/803_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/803_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card803.html" }).map(csvCell).join(","),
    row({ id: "000803", title: "読み矛盾", titleReading: "よみに", sortReading: "よみいち", textUrl: "https://www.aozora.gr.jp/cards/000148/files/803_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/803_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card803.html" }).map(csvCell).join(","),
  ].join("\r\n");
  const zip = new JSZip();
  zip.file("list_person_all_extended_utf8.csv", csv);
  const archive = await zip.generateAsync({ type: "uint8array" });
  const xhtml = new TextEncoder().encode('<html><div class="main_text">短い本文</div></html>');
  const fetcher = async (input) => {
    const url = String(input);
    if (url === "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip") {
      return new Response(archive, { status: 200, headers: { "content-type": "application/zip" } });
    }
    return new Response(xhtml, { status: 200, headers: { "content-type": "application/xhtml+xml" } });
  };

  const snapshot = await resolveAozoraRightsCatalog(fetcher);
  const byId = new Map(snapshot.works.map((work) => [work.id, work]));
  assert.equal(snapshot.works.length, 5);
  assert.equal(byId.get("000799").sourceMetadata.firstPublication, '雑誌 "新潮",\n1910年');
  assert.equal(classifyAozoraRightsWork(byId.get("000799")).classification, "candidate_pending_human_review");
  assert.equal(byId.get("000800").contributors.length, 2);
  assert.equal(classifyAozoraRightsWork(byId.get("000800")).classification, "B");
  assert.equal(classifyAozoraRightsWork(byId.get("000801")).classification, "C");
  assert.equal(classifyAozoraRightsWork(byId.get("000802")).classification, "B");
  assert.equal(classifyAozoraRightsWork(byId.get("000803")).classification, "B");
  assert.ok(byId.get("000803").catalogIssues.includes("title_reading_conflict"));
  assert.deepEqual(classifyAozoraCatalog(snapshot.works), { candidate_pending_human_review: 1, B: 3, C: 1 });

  const [edition] = await resolveAozoraWorkEditions(["000799"], fetcher);
  assert.equal(edition.sourceSha256, createHash("sha256").update(xhtml).digest("hex"));
});

test("missing, conflicting flags and multiple or non-author contributors are fail-closed", () => {
  assert.equal(classifyAozoraRightsWork(fixtureWork({ workCopyrightFlags: ["なし", ""] })).classification, "B");
  assert.equal(classifyAozoraRightsWork(fixtureWork({ contributors: [{ ...fixtureWork().contributors[0], copyrightFlags: ["なし", "あり"] }] })).classification, "C");
  assert.equal(classifyAozoraRightsWork(fixtureWork({ contributors: [{ ...fixtureWork().contributors[0], copyrightFlags: ["なし", "不明"] }] })).classification, "B");
  assert.equal(classifyAozoraRightsWork(fixtureWork({ contributors: [{ ...fixtureWork().contributors[0], role: "翻訳者" }] })).classification, "B");
  assert.equal(classifyAozoraRightsWork(fixtureWork({ catalogIssues: ["work_identity_conflict"] })).classification, "B");
});

test("review package hashes edition bytes and SQL requires explicit unanimous human approval", async () => {
  const editionBytes = new TextEncoder().encode('<html><div class="main_text">版テキスト</div></html>');
  const work = fixtureWork();
  const hash = createHash("sha256").update(editionBytes).digest("hex");
  const reviewPackage = createAozoraRightsReviewPackage({
    catalogUrl: "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip",
    fetchedAt: "2026-11-20T00:00:00.000Z",
    catalogSha256: "a".repeat(64),
    catalogWorks: [work],
    selectionLimit: 1,
    selectedIds: [work.id],
    editionsById: new Map([[work.id, { ...work, sourceSha256: hash }]]),
  });
  assert.equal(reviewPackage.works[0].sourceSha256, hash);
  assert.equal(reviewPackage.packageSha256, calculateReviewPackageSha256(reviewPackage));

  const baseApproval = {
    schema: "amuhon-aozora-rights-approval/v1",
    packageSha256: reviewPackage.packageSha256,
    catalogSha256: reviewPackage.catalog.sha256,
    explicitHumanApproval: true,
    approvalStatement: AOZORA_BATCH_APPROVAL_STATEMENT,
    checkedBy: "運営者（実入力）",
    checkedAt: "2026-11-20T12:00:00+09:00",
    works: [{
      workId: work.id,
      sourceSha256: hash,
      approveAsA: true,
      domesticOriginalWorkConfirmed: true,
      allRightsAndProtectionTermConfirmed: true,
      noTranslationAdaptationCoauthorOrThirdPartyIssueConfirmed: true,
      commercialUseAndAttributionConfirmed: true,
      evidenceBasis: "人が確認した根拠を記載",
      permissionConditions: "青空文庫の出典表示と個別の利用条件を遵守",
      holders: [{ name: "夏目 漱石", role: "著者", reviewedAndApprovedAsA: true, evidenceBasis: "関係者を確認", permissionConditions: "出典表示を維持" }],
    }],
  };
  const sql = generateAozoraRightsRegistrationSql(reviewPackage, baseApproval);
  assert.match(sql, /begin;/);
  assert.match(sql, /insert into public\.amuhon_work_commercial_rights/);
  assert.match(sql, /insert into public\.amuhon_work_rights_holders/);
  assert.match(sql, /'A'/);
  assert.match(sql, /rights_reviews_complete/);
  assert.match(sql, /RIGHTS_BATCH_RECORD_ALREADY_EXISTS/);
  assert.doesNotMatch(sql, /on conflict/i);
  assert.throws(() => generateAozoraRightsRegistrationSql(reviewPackage, { ...baseApproval, explicitHumanApproval: false }), /approval_explicit_human_approval_required/);
  assert.throws(() => generateAozoraRightsRegistrationSql(reviewPackage, { ...baseApproval, checkedBy: "運営者\n-- injected" }), /approval_reviewer_invalid/);
  assert.throws(() => generateAozoraRightsRegistrationSql(reviewPackage, { ...baseApproval, works: [{ ...baseApproval.works[0], sourceSha256: "b".repeat(64) }] }), /approval_work_not_current_candidate/);
  for (const classification of ["B", "C"]) {
    const protectedPackage = { ...reviewPackage, works: [{ ...reviewPackage.works[0], classification }] };
    const protectedPayload = { ...protectedPackage };
    delete protectedPayload.packageSha256;
    protectedPackage.packageSha256 = calculateReviewPackageSha256(protectedPayload);
    const protectedApproval = { ...baseApproval, packageSha256: protectedPackage.packageSha256 };
    assert.throws(() => generateAozoraRightsRegistrationSql(protectedPackage, protectedApproval), /approval_work_not_current_candidate/);
  }
  const forgedProtectedPackage = { ...reviewPackage, works: [{ ...reviewPackage.works[0], workCopyrightFlags: ["あり"] }] };
  const forgedPayload = { ...forgedProtectedPackage };
  delete forgedPayload.packageSha256;
  forgedProtectedPackage.packageSha256 = calculateReviewPackageSha256(forgedPayload);
  assert.throws(() => generateAozoraRightsRegistrationSql(forgedProtectedPackage, { ...baseApproval, packageSha256: forgedProtectedPackage.packageSha256 }), /approval_work_not_current_candidate/);
});

test("classification and SQL generator remain separate from order authorization", async () => {
  const [rights, order, migration] = await Promise.all([
    readFile(new URL("lib/aozora-rights-review.ts", ROOT), "utf8"),
    readFile(new URL("app/api/orders/route.ts", ROOT), "utf8"),
    readFile(new URL("supabase/migrations/20261118000100_work_commercial_rights_ledger.sql", ROOT), "utf8"),
  ]);
  assert.match(rights, /classification: "candidate_pending_human_review"/);
  assert.match(order, /resolveAozoraWorkEditions\(bookSelection\.workIds\)/);
  assert.match(order, /check_amuhon_works_commercial_rights_v1/);
  assert.match(migration, /rights\.status = 'A'/);
  assert.match(migration, /holder\.status = 'A'/);
});

test("review outputs are local-only and excluded from version control", async () => {
  const gitignore = await readFile(new URL(".gitignore", ROOT), "utf8");
  const prepare = await readFile(new URL("scripts/prepare-aozora-rights-review.mjs", ROOT), "utf8");
  const generate = await readFile(new URL("scripts/generate-aozora-rights-registration-sql.mjs", ROOT), "utf8");
  assert.match(gitignore, /\.local-assets\/rights-review/);
  assert.match(prepare, /MAX|limit/);
  assert.match(prepare, /resolveAozoraWorkEditions\(\[id\]\)/);
  assert.match(generate, /resolveAozoraRightsCatalog\(\)/);
  assert.match(generate, /resolveAozoraWorkEditions\(\[approvalWork\.workId\]\)/);
  assert.doesNotMatch(generate, /SUPABASE_|STRIPE_/);
});
