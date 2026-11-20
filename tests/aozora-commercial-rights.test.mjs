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
  assert.match(worker, /record\.catalogRights\.classification !== "A"/);
  assert.match(worker, /sameAozoraRightsFacts\(selected\.catalogRights, record\.catalogRights\)/);
  assert.match(parser, /parseAozoraCommercialRightsSnapshot\(work\.catalogRights\)/);
});
