import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import { resolveAozoraEditionByXhtmlUrl } from "../lib/aozora-edition.ts";
import {
  classifyAozoraCommercialRights,
  createAozoraCommercialRightsSnapshot,
  parseAozoraCommercialRightsSnapshot,
  sameAozoraRightsFacts,
} from "../lib/aozora-commercial-rights.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const catalogAudit = { fetchedAt: "2026-11-21T00:00:00.000Z", sha256: "a".repeat(64) };

function fixture(overrides = {}) {
  return {
    id: "15", title: "作品", titleReading: "さくひん", sortReading: "さくひん",
    author: "作者 名", cardUrl: "https://www.aozora.gr.jp/cards/000001/card15.html",
    textUrl: "https://www.aozora.gr.jp/cards/000001/files/15_1.zip",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000001/files/15_1.html",
    contributors: [{ name: "作者 名", role: "著者", reading: "さくしゃ めい", personIds: ["000001"], copyrightFlags: ["なし"], missingCopyrightFlagRows: 0 }],
    sourceMetadata: { firstPublication: "初出", baseText: "底本", basePublisher: "出版社", inputter: "入力者", proofreader: "校正者" },
    workCopyrightFlags: ["なし"], missingWorkCopyrightFlagRows: 0,
    catalogPersonCopyrightFlags: ["なし"], missingPersonCopyrightFlagRows: 0,
    incompleteContributorRows: 0, sourceMetadataConflicts: [], catalogIssues: [], catalogRowCount: 1,
    ...overrides,
  };
}

test("official no-rights flags and one identified author produce operational A", () => {
  const result = classifyAozoraCommercialRights(fixture());
  assert.equal(result.classification, "A");
  assert.deepEqual(result.reasons, ["official_flags_none_single_author_scope"]);
  const snapshot = createAozoraCommercialRightsSnapshot(fixture(), catalogAudit);
  assert.equal(parseAozoraCommercialRightsSnapshot(snapshot)?.classification, "A");
});

test("any work or person copyright-present flag classifies C", () => {
  assert.equal(classifyAozoraCommercialRights(fixture({ workCopyrightFlags: ["なし", "あり"] })).classification, "C");
  const protectedPerson = fixture({
    catalogPersonCopyrightFlags: ["あり"],
    contributors: [{ ...fixture().contributors[0], copyrightFlags: ["あり"] }],
  });
  assert.equal(classifyAozoraCommercialRights(protectedPerson).classification, "C");
});

test("missing or conflicting flags and non-single-author roles remain B", () => {
  assert.equal(classifyAozoraCommercialRights(fixture({ workCopyrightFlags: ["なし", "不明"] })).classification, "B");
  assert.equal(classifyAozoraCommercialRights(fixture({ missingPersonCopyrightFlagRows: 1 })).classification, "B");
  assert.equal(classifyAozoraCommercialRights(fixture({
    contributors: [{ ...fixture().contributors[0], role: "翻訳者" }],
  })).classification, "B");
  assert.equal(classifyAozoraCommercialRights(fixture({ catalogIssues: ["work_identity_conflict"] })).classification, "B");
});

test("catalog-wide digest refresh does not change per-work rights facts", () => {
  const first = createAozoraCommercialRightsSnapshot(fixture(), catalogAudit);
  const second = createAozoraCommercialRightsSnapshot(fixture(), {
    fetchedAt: "2026-11-22T00:00:00.000Z", sha256: "b".repeat(64),
  });
  assert.notEqual(first.catalogSha256, second.catalogSha256);
  assert.equal(sameAozoraRightsFacts(first, second), true);
  const changed = createAozoraCommercialRightsSnapshot(fixture({ workCopyrightFlags: ["あり"] }), catalogAudit);
  assert.equal(sameAozoraRightsFacts(first, changed), false);
});

test("selected official XHTML bytes are hashed exactly and unrelated catalog digest is separate", async () => {
  const headers = ["作品ID", "作品名", "姓", "名", "役割フラグ", "姓読み", "名読み", "作品名読み", "ソート用読み",
    "図書カードURL", "テキストファイルURL", "XHTMLファイルURL", "初出", "底本名1", "底本出版社名1", "入力者", "校正者",
    "作品著作権フラグ", "人物ID", "人物著作権フラグ"];
  const values = ["799", "夢十夜", "夏目", "漱石", "著者", "なつめ", "そうせき", "ゆめじゅうや", "ゆめじゅうや",
    "https://www.aozora.gr.jp/cards/000148/card799.html", "https://www.aozora.gr.jp/cards/000148/files/799_ruby_14972.zip",
    "https://www.aozora.gr.jp/cards/000148/files/799_14972.html", "初出", "底本", "出版社", "入力者", "校正者", "なし", "000148", "なし"];
  const csvCell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const archive = new JSZip();
  archive.file("catalog.csv", [headers.map(csvCell).join(","), values.map(csvCell).join(",")].join("\n"));
  const zipBytes = await archive.generateAsync({ type: "uint8array" });
  const xhtmlBytes = new TextEncoder().encode('<html><body><div class="main_text">本文</div></body></html>');
  const expectedSha = createHash("sha256").update(xhtmlBytes).digest("hex");
  const calls = [];
  const resolved = await resolveAozoraEditionByXhtmlUrl(values[11], async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return String(url) === "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip"
      ? new Response(zipBytes, { headers: { "content-type": "application/zip" } })
      : new Response(xhtmlBytes, { headers: { "content-type": "application/xhtml+xml; charset=utf-8" } });
  });
  assert.equal(resolved.work.id, "799");
  assert.equal(resolved.work.cardUrl, values[9]);
  assert.equal(resolved.work.sourceSha256, expectedSha);
  assert.equal(resolved.bytes.byteLength, xhtmlBytes.byteLength);
  assert.deepEqual(calls.map((call) => call.redirect), ["error", "error"]);
  assert.equal(createAozoraCommercialRightsSnapshot(resolved.work, {
    fetchedAt: resolved.catalogFetchedAt, sha256: resolved.catalogSha256,
  }).classification, "A");
});

test("new migration keeps the old edition-bound fallback and applies manual stops at shared gates", async () => {
  const migration = await read("supabase/migrations/20261121000100_aozora_official_rights_status.sql");
  const previous = await read("supabase/migrations/20261118000100_work_commercial_rights_ledger.sql");
  assert.match(migration, /create table if not exists public\.amuhon_work_rights_manual_stop_events/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.amuhon_work_rights_manual_stop_events from public, anon, authenticated, service_role/);
  assert.match(migration, /_amuhon_work_rights_manual_stop_active_v1\(target_work ->> 'id'\)/);
  assert.match(migration, /pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(p_work_id, 0\)\)/);
  assert.match(migration, /catalogRights/);
  assert.match(migration, /public\.amuhon_work_commercial_rights as rights/);
  assert.match(migration, /rights\.source_sha256 = target_work ->> 'sourceSha256'/);
  assert.match(migration, /check_amuhon_order_commercial_rights_v1\(uuid, text\)/);
  assert.match(migration, /get_amuhon_order_rights_snapshot_v1\(uuid, text\)/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  const claimStart = migration.indexOf("create or replace function public.claim_amuhon_order_pdf_render_job");
  const claimEnd = migration.indexOf("revoke all on function public.claim_amuhon_order_pdf_render_job", claimStart);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claimFunction = migration.slice(claimStart, claimEnd);
  assert.match(claimFunction, /_amuhon_book_works_rights_approved_v1\(target_order\.book_snapshot -> 'works', true\)/);
  assert.ok(claimFunction.indexOf("_amuhon_book_works_rights_approved_v1") < claimFunction.indexOf("new_lease_id :="));
  assert.match(previous, /if not public\._amuhon_book_works_rights_approved_v1\(target_order\.book_snapshot -> 'works', true\) then/);
  assert.doesNotMatch(migration, /insert into public\.amuhon_work_commercial_rights/i);
  assert.match(previous, /rights\.source_sha256 = target_work ->> 'sourceSha256'/);
});

test("101 older manually stopped jobs do not starve a later eligible claim", async () => {
  const migration = await read("supabase/migrations/20261121000100_aozora_official_rights_status.sql");
  const claimStart = migration.indexOf("create or replace function public.claim_amuhon_order_pdf_render_job");
  const claimEnd = migration.indexOf("revoke all on function public.claim_amuhon_order_pdf_render_job", claimStart);
  const claimFunction = migration.slice(claimStart, claimEnd);
  const candidateStart = claimFunction.indexOf("for candidate in");
  const candidateEnd = claimFunction.indexOf("loop", candidateStart);
  const candidateQuery = claimFunction.slice(candidateStart, candidateEnd);

  assert.match(candidateQuery, /join public\.amuhon_orders as candidate_order on candidate_order\.id = jobs\.order_id/);
  assert.match(candidateQuery, /and not public\._amuhon_book_works_manual_stop_active_v1\(candidate_order\.book_snapshot -> 'works'\)/);
  assert.ok(candidateQuery.indexOf("_amuhon_book_works_manual_stop_active_v1") < candidateQuery.indexOf("limit 100"));
  const stopHelperStart = migration.indexOf("create or replace function public._amuhon_book_works_manual_stop_active_v1");
  const stopHelperEnd = migration.indexOf("revoke all on function public._amuhon_book_works_manual_stop_active_v1", stopHelperStart);
  const stopHelper = migration.slice(stopHelperStart, stopHelperEnd);
  assert.match(stopHelper, /stable\s+security definer\s+set search_path = pg_catalog, pg_temp/i);
  assert.match(migration, /revoke all on function public\._amuhon_book_works_manual_stop_active_v1\(jsonb\) from public, anon, authenticated, service_role/i);
  assert.match(claimFunction, /pg_advisory_xact_lock\([\s\S]*?hashtextextended\(target_work ->> 'id', 0\)[\s\S]*?\)/);
  const pausedBranch = claimFunction.match(/if public\._amuhon_book_works_manual_stop_active_v1\(target_order\.book_snapshot -> 'works'\) then\s+continue;\s+end if;/)?.[0];
  assert.ok(pausedBranch);
  assert.doesNotMatch(pausedBranch, /update public\.amuhon_order_pdf_render_jobs/i);
  assert.match(claimFunction, /if not public\._amuhon_book_works_rights_approved_v1\(target_order\.book_snapshot -> 'works', true\) then\s+update public\.amuhon_order_pdf_render_jobs set\s+state = 'failed',[\s\S]*?error_code = 'rights_ineligible'/);
  assert.match(migration, /'page_count_mismatch', 'internal_error', 'rights_unverified', 'rights_ineligible'/);

  const backlog = Array.from({ length: 101 }, (_, index) => ({ id: `stopped-${index + 1}`, stopped: true }));
  backlog.push({ id: "later-eligible", stopped: false });
  const selected = backlog.filter((job) => !job.stopped).slice(0, 100);
  assert.deepEqual(selected.map((job) => job.id), ["later-eligible"]);
  assert.equal(backlog.find((job) => job.id === "stopped-1").stopped, true);
  const afterResume = backlog.map((job) => job.id === "stopped-1" ? { ...job, stopped: false } : job)
    .filter((job) => !job.stopped).slice(0, 100);
  assert.equal(afterResume[0].id, "stopped-1");

  const stopBeforeLimit = candidateQuery.indexOf("_amuhon_book_works_manual_stop_active_v1");
  const limitAt = candidateQuery.indexOf("limit 100");
  assert.ok(stopBeforeLimit >= 0 && limitAt > stopBeforeLimit);
});

test("render-job error constraint preserves legacy and current rights codes", async () => {
  const [migration, legacyMigration] = await Promise.all([
    read("supabase/migrations/20261121000100_aozora_official_rights_status.sql"),
    read("supabase/migrations/20261118000100_work_commercial_rights_ledger.sql"),
  ]);
  const constraintStart = migration.indexOf("add constraint amuhon_order_pdf_render_job_error_code");
  const constraintEnd = migration.indexOf("\n  );", constraintStart);
  assert.ok(constraintStart >= 0 && constraintEnd > constraintStart);
  const constraint = migration.slice(constraintStart, constraintEnd);
  const permittedCodes = [...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

  assert.ok(permittedCodes.includes("rights_unverified"));
  assert.ok(permittedCodes.includes("rights_ineligible"));
  assert.match(legacyMigration, /error_code := 'rights_unverified'/);
  assert.match(migration, /error_code = 'rights_ineligible'/);
});

test("text API and renderer bind fetched content to official catalog rights and exact edition SHA", async () => {
  const [route, worker, parser] = await Promise.all([
    read("app/api/aozora/route.ts"),
    read("scripts/render-order-assets-worker.mjs"),
    read("lib/local-order-pdf-request.ts"),
  ]);
  assert.match(route, /resolveAozoraEditionByXhtmlUrl\(sourceUrl/);
  assert.match(route, /sourceSha256: edition\.work\.sourceSha256/);
  assert.match(route, /catalogRights/);
  assert.match(worker, /record\.sourceSha256 !== selected\.sourceSha256/);
  assert.match(worker, /parseAozoraCommercialRightsSnapshot\(record\?\.catalogRights\)/);
  assert.match(worker, /currentRights\.classification !== "A"/);
  assert.match(worker, /sameAozoraRightsFacts\(selected\.catalogRights, currentRights\)/);
  assert.match(worker, /"x-amuhon-pdf-worker-secret": internalSecret/);
  assert.match(worker, /AMUHON_PDF_WORKER_SECRET: process\.env\.AMUHON_PDF_WORKER_SECRET/);
  assert.match(route, /const includeInternalRights = isTrustedRendererRequest\(request\)/);
  assert.match(route, /\.\.\.\(catalogRights \? \{ catalogRights \} : \{\}\)/);
  assert.match(route, /function isTrustedRendererRequest\(request: Request\)/);
  assert.match(route, /Cache-Control": "no-store, private/);
  assert.match(parser, /parseAozoraCommercialRightsSnapshot\(work\.catalogRights\)/);
});
