import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";

import {
  AOZORA_BATCH_APPROVAL_STATEMENT,
  calculateAozoraRightsPolicySha256,
  classifyAozoraCatalog,
  classifyAozoraRightsWork,
  createAozoraRightsBatchApprovalTemplate,
  createAozoraRightsBatchReviewPackage,
  createAozoraRightsReviewPackage,
  generateAozoraRightsBatchRegistrationSql,
  validateAozoraRightsBatchApproval,
} from "../lib/aozora-rights-review.ts";
import { AOZORA_ATTRIBUTION_NOTICE } from "../lib/aozora-commercial-rights.ts";
import { resolveAozoraRightsCatalog, resolveAozoraWorkEditions } from "../lib/aozora-edition.ts";

const ROOT = new URL("../", import.meta.url);
const policyDraft = JSON.parse(await readFile(new URL("data/aozora-rights-policy-v1.json", ROOT), "utf8"));

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
  titleReading = title, sortReading = title, family = "夏目", given = "漱石", role = "著者",
  firstPublication = "", baseText = "夏目漱石全集10",
  textUrl = "https://www.aozora.gr.jp/cards/000148/files/799_ruby_6024.zip",
  xhtmlUrl = "https://www.aozora.gr.jp/cards/000148/files/799_14972.html",
  cardUrl = "https://www.aozora.gr.jp/cards/000148/card799.html",
} = {}) {
  return [id, title, titleReading, sortReading, firstPublication, workFlag, cardUrl, personId, family, given, "なつめ", "そうせき", role, personFlag, baseText, "筑摩書房", "入力者", "校正者", textUrl, xhtmlUrl];
}

function fixtureWork(id = "000799", overrides = {}) {
  return {
    id, title: "夢十夜", titleReading: "ゆめじゅうや", sortReading: "ゆめじゅうや",
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

function approvedPolicy() {
  const policy = structuredClone(policyDraft);
  policy.status = "active";
  policy.legalReviewStatus = "confirmed";
  policy.approvedBy = "運営責任者（合成テスト）";
  policy.approvedAt = "2026-11-20T10:00:00+09:00";
  policy.legalReviewedBy = "法務確認者（合成テスト）";
  policy.legalReviewedAt = "2026-11-20T09:00:00+09:00";
  policy.legalReviewEvidence = "合成テスト用の架空の法務確認記録";
  return policy;
}

function reviewPackageFor(works, hashes) {
  return createAozoraRightsReviewPackage({
    catalogUrl: "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip",
    fetchedAt: "2026-11-20T00:00:00.000Z",
    catalogSha256: "a".repeat(64),
    catalogWorks: works,
    selectionLimit: works.length,
    selectedIds: works.map((work) => work.id),
    editionsById: new Map(works.map((work) => [work.id, { ...work, sourceSha256: hashes.get(work.id) }])) ,
  });
}

function approvalFor(batchPackage, approvedWorkIds = batchPackage.selection.proposedWorkIds) {
  const template = createAozoraRightsBatchApprovalTemplate(batchPackage);
  return {
    ...template,
    explicitHumanApproval: true,
    checkedBy: "ダイスケ（合成テスト）",
    checkedAt: "2026-11-20T12:00:00+09:00",
    approvedWorkIds,
    exceptions: batchPackage.selection.proposedWorkIds
      .filter((id) => !approvedWorkIds.includes(id))
      .map((workId) => ({ workId, disposition: "individual_review", reason: "合成テストで個別審査へ回す" })),
    commonReviewBasis: "合成テストで定義した共通審査の根拠。実作品の承認を意味しない。",
    commonPermissionConditions: AOZORA_ATTRIBUTION_NOTICE,
  };
}

function currentSnapshot(works, sha256 = "b".repeat(64)) {
  return { fetchedAt: "2026-11-21T00:00:00.000Z", sha256, works };
}

function sqlFor({ works = [fixtureWork()], hashes } = {}) {
  const editionHashes = hashes ?? new Map(works.map((work) => [work.id, createHash("sha256").update(`xhtml-${work.id}`).digest("hex")]));
  const reviewPackage = reviewPackageFor(works, editionHashes);
  const policy = approvedPolicy();
  const batchPackage = createAozoraRightsBatchReviewPackage(reviewPackage, policy);
  const approval = approvalFor(batchPackage);
  const editionsById = new Map(works.map((work) => [work.id, { ...work, sourceSha256: editionHashes.get(work.id) }]));
  const sql = generateAozoraRightsBatchRegistrationSql({
    batchPackage, approval, policy, currentCatalog: currentSnapshot(works), editionsById,
  });
  return { sql, policy, reviewPackage, batchPackage, approval, editionsById };
}

test("official CSV parser aggregates multi-row contributors and hashes exact XHTML bytes", async () => {
  const csv = [
    headers.map(csvCell).join(","),
    row({ firstPublication: '雑誌 "新潮",\n1910年' }).map(csvCell).join(","),
    row({ id: "000800", title: "翻訳作品", textUrl: "https://www.aozora.gr.jp/cards/000148/files/800_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/800_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card800.html" }).map(csvCell).join(","),
    row({ id: "000800", title: "翻訳作品", personId: "000900", family: "翻訳", given: "者", role: "翻訳者", textUrl: "https://www.aozora.gr.jp/cards/000148/files/800_ruby_1.zip", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/800_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card800.html" }).map(csvCell).join(","),
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
    if (String(input) === "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip") {
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
  assert.ok(byId.get("000803").catalogIssues.includes("title_reading_conflict"));
  assert.deepEqual(classifyAozoraCatalog(snapshot.works), { candidate_pending_human_review: 1, B: 3, C: 1 });
  const [edition] = await resolveAozoraWorkEditions(["000799"], fetcher);
  assert.equal(edition.sourceSha256, createHash("sha256").update(xhtml).digest("hex"));
});

test("policy starts draft/unconfirmed and blocks A registration until active legal review", () => {
  const reviewPackage = reviewPackageFor([fixtureWork()], new Map([["000799", "c".repeat(64)]]));
  const batchPackage = createAozoraRightsBatchReviewPackage(reviewPackage, policyDraft);
  assert.equal(batchPackage.screening.bulkCandidateCount, 1);
  assert.equal(batchPackage.screening.registrationEligibleCount, 0);
  assert.equal(batchPackage.screening.aRegistrationAllowed, false);
  const approval = approvalFor(batchPackage);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, approval, policyDraft), /rights_policy_not_legally_approved_active/);
  const legallyUnconfirmed = approvedPolicy();
  legallyUnconfirmed.legalReviewStatus = "unconfirmed";
  const withUnconfirmedPolicy = createAozoraRightsBatchReviewPackage(reviewPackage, legallyUnconfirmed);
  assert.throws(() => validateAozoraRightsBatchApproval(withUnconfirmedPolicy, approvalFor(withUnconfirmedPolicy), legallyUnconfirmed), /rights_policy_not_legally_approved_active/);
  const suspendedPolicy = approvedPolicy();
  suspendedPolicy.status = "suspended";
  const withSuspendedPolicy = createAozoraRightsBatchReviewPackage(reviewPackage, suspendedPolicy);
  assert.equal(withSuspendedPolicy.screening.aRegistrationAllowed, false);
  assert.equal(withSuspendedPolicy.screening.registrationEligibleCount, 0);
  assert.throws(() => validateAozoraRightsBatchApproval(withSuspendedPolicy, approvalFor(withSuspendedPolicy), suspendedPolicy), /rights_policy_not_legally_approved_active/);
  const missingLegalEvidence = approvedPolicy();
  missingLegalEvidence.legalReviewEvidence = " ";
  const withMissingEvidence = createAozoraRightsBatchReviewPackage(reviewPackage, missingLegalEvidence);
  assert.equal(withMissingEvidence.screening.aRegistrationAllowed, false);
  assert.throws(() => validateAozoraRightsBatchApproval(withMissingEvidence, approvalFor(withMissingEvidence), missingLegalEvidence), /rights_policy_not_legally_approved_active/);
  const incompletePolicy = approvedPolicy();
  incompletePolicy.eligibilityCriteria = [];
  assert.throws(() => createAozoraRightsBatchReviewPackage(reviewPackage, incompletePolicy), /rights_batch_input_invalid/);
  assert.equal(calculateAozoraRightsPolicySha256(policyDraft), batchPackage.policy.sha256);
});

test("B/C, unknown, missing, conflicting flags and translation roles stay outside the bulk candidate set", () => {
  const valid = fixtureWork("000799");
  const protectedWork = fixtureWork("000801", { workCopyrightFlags: ["あり"], catalogPersonCopyrightFlags: ["あり"], contributors: [{ ...fixtureWork().contributors[0], copyrightFlags: ["あり"] }] });
  const unknownWork = fixtureWork("000802", { workCopyrightFlags: ["不明"] });
  const translationWork = fixtureWork("000800", { contributors: [{ ...fixtureWork().contributors[0], role: "翻訳者" }] });
  const hashes = new Map([[valid.id, "a".repeat(64)], [protectedWork.id, "b".repeat(64)], [unknownWork.id, "c".repeat(64)], [translationWork.id, "d".repeat(64)]]);
  const reviewPackage = reviewPackageFor([valid, protectedWork, unknownWork, translationWork], hashes);
  const policy = approvedPolicy();
  const batchPackage = createAozoraRightsBatchReviewPackage(reviewPackage, policy);
  assert.deepEqual(batchPackage.screening, {
    bulkCandidateCount: 1,
    individualReviewCount: 2,
    excludedCount: 1,
    registrationEligibleCount: 1,
    aRegistrationAllowed: true,
  });
  assert.deepEqual(batchPackage.selection.proposedWorkIds, ["000799"]);
  const approval = approvalFor(batchPackage, ["000801"]);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, approval, policy), /approval_selection_contains_ineligible_work/);
});

test("batch approval requires one common basis and an exact approved/exceptions partition", () => {
  const first = fixtureWork("000799");
  const second = fixtureWork("000800", { title: "作品二", xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/800_1.html", cardUrl: "https://www.aozora.gr.jp/cards/000148/card800.html", textUrl: "https://www.aozora.gr.jp/cards/000148/files/800_ruby_1.zip" });
  const hashes = new Map([[first.id, "1".repeat(64)], [second.id, "2".repeat(64)]]);
  const reviewPackage = reviewPackageFor([first, second], hashes);
  const policy = approvedPolicy();
  const batchPackage = createAozoraRightsBatchReviewPackage(reviewPackage, policy);
  const onlyFirst = approvalFor(batchPackage, [first.id]);
  assert.equal(validateAozoraRightsBatchApproval(batchPackage, onlyFirst, policy).approvedWorks.length, 1);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, { ...onlyFirst, exceptions: [] }, policy), /approval_target_partition_incomplete/);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, { ...onlyFirst, explicitHumanApproval: false }, policy), /approval_explicit_human_approval_required/);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, { ...onlyFirst, approvalStatement: "個別に全作品を確認した" }, policy), /approval_statement_mismatch/);
  assert.throws(() => validateAozoraRightsBatchApproval(batchPackage, { ...onlyFirst, approvedWorkIds: [first.id, first.id] }, policy), /approval_selection_invalid/);
});

test("unrelated catalog updates are recorded but do not block; target metadata changes do", () => {
  const work = fixtureWork();
  const { batchPackage, approval, policy, editionsById } = sqlFor({ works: [work] });
  const unrelated = fixtureWork("000999", { title: "無関係な追加作品" });
  const updatedGlobal = currentSnapshot([work, unrelated], "e".repeat(64));
  const sql = generateAozoraRightsBatchRegistrationSql({ batchPackage, approval, policy, currentCatalog: updatedGlobal, editionsById });
  assert.match(sql, /currentCatalogSha256/);
  const changedTarget = fixtureWork("000799", { ...work, title: "変更された対象作品" });
  assert.throws(() => generateAozoraRightsBatchRegistrationSql({ batchPackage, approval, policy, currentCatalog: currentSnapshot([changedTarget], "f".repeat(64)), editionsById }), /catalog_record_changed/);
});

test("target XHTML hash changes stop SQL generation; identical latest hashes produce auditable SQL", () => {
  const work = fixtureWork();
  const { sql, batchPackage, approval, policy } = sqlFor({ works: [work] });
  assert.match(sql, /insert into public\.amuhon_aozora_rights_policy_registry/);
  assert.match(sql, /insert into public\.amuhon_aozora_rights_scope_batches/);
  assert.match(sql, /insert into public\.amuhon_aozora_rights_scope_members/);
  assert.match(sql, /approved_by/);
  assert.match(sql, /approved_set_sha256/);
  assert.match(sql, /'ダイスケ（合成テスト）', '2026-11-20T12:00:00\+09:00'::timestamptz/);
  assert.match(sql, /permission_conditions/);
  assert.match(sql, /approved_by is null/);
  assert.doesNotMatch(sql, /insert into public\.amuhon_work_commercial_rights/i);
  assert.doesNotMatch(sql, /insert into public\.amuhon_work_rights_holders/i);
  assert.match(sql, /approvedSetSha256/);
  assert.match(sql, /legalReviewEvidence/);
  assert.match(sql, /on conflict \(policy_id, policy_version\)[\s\S]*?policy_status = 'draft'[\s\S]*?legal_review_status = 'unconfirmed'/i);
  assert.doesNotMatch(sql, /on conflict \(batch_package_sha256\)/i);
  const mismatch = new Map([[work.id, { ...work, sourceSha256: "f".repeat(64) }]]);
  assert.throws(() => generateAozoraRightsBatchRegistrationSql({
    batchPackage, approval, policy, currentCatalog: currentSnapshot([work]), editionsById: mismatch,
  }), /xhtml_edition_changed/);
  assert.equal(approval.approvalStatement, AOZORA_BATCH_APPROVAL_STATEMENT);
});

test("batch classification and SQL remain separate from the existing order rights gate", async () => {
  const [review, order, migration, sqlScript] = await Promise.all([
    readFile(new URL("lib/aozora-rights-review.ts", ROOT), "utf8"),
    readFile(new URL("app/api/orders/route.ts", ROOT), "utf8"),
    readFile(new URL("supabase/migrations/20261118000100_work_commercial_rights_ledger.sql", ROOT), "utf8"),
    readFile(new URL("scripts/generate-aozora-rights-registration-sql.mjs", ROOT), "utf8"),
  ]);
  assert.match(review, /policy\.status !== "active" \|\| !policyReady\(policy\)/);
  assert.match(order, /resolveAozoraWorkEditionsWithCatalog\(bookSelection\.workIds, fetch, true\)/);
  assert.match(order, /check_amuhon_works_commercial_rights_v1/);
  assert.match(migration, /rights\.status = 'A'/);
  assert.match(migration, /holder\.status = 'A'/);
  assert.match(sqlScript, /resolveAozoraRightsCatalog\(\)/);
  assert.doesNotMatch(sqlScript, /SUPABASE_|STRIPE_/);
});

test("outputs remain local-only and no SQL is generated by the draft review command", async () => {
  const [gitignore, prepare, fullPrepare, packageJson, policy] = await Promise.all([
    readFile(new URL(".gitignore", ROOT), "utf8"),
    readFile(new URL("scripts/prepare-aozora-rights-batch-review.mjs", ROOT), "utf8"),
    readFile(new URL("scripts/prepare-aozora-rights-review.mjs", ROOT), "utf8"),
    readFile(new URL("package.json", ROOT), "utf8"),
    readFile(new URL("data/aozora-rights-policy-v1.json", ROOT), "utf8"),
  ]);
  assert.match(gitignore, /\.local-assets\/rights-review/);
  assert.match(prepare, /createAozoraRightsBatchReviewPackage/);
  assert.match(prepare, /No human approval was recorded/);
  assert.match(fullPrepare, /batch-approval-template\.json/);
  assert.doesNotMatch(fullPrepare, /"approval-template\.json"/);
  assert.match(packageJson, /rights:aozora:batch/);
  const parsedPolicy = JSON.parse(policy);
  assert.equal(parsedPolicy.status, "draft");
  assert.equal(parsedPolicy.legalReviewStatus, "unconfirmed");
  assert.equal(parsedPolicy.approvedBy, null);
  assert.equal(parsedPolicy.legalReviewedBy, null);
});
