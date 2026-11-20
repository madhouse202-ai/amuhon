import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseCommercialRightsApproval, parseCommercialRightsDecision } from "../lib/commercial-rights.ts";
import { isLegacyBuyerAssetFlowEnabled } from "../lib/order-production-gate.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const HASH = "a".repeat(64);

test("rights response parser accepts only bounded, explicit ledger notices", () => {
  assert.equal(parseCommercialRightsDecision({ approved: true }), true);
  assert.equal(parseCommercialRightsDecision({ approved: false }), false);
  assert.equal(parseCommercialRightsDecision({ approved: false, extra: "unexpected" }), null);
  assert.equal(parseCommercialRightsDecision(null), null);
  assert.deepEqual(parseCommercialRightsApproval({ approved: false, notices: [] }), { approved: false, notices: [] });
  assert.deepEqual(parseCommercialRightsApproval({ approved: true, notices: [{ workId: "000015", sourceSha256: HASH, conditions: "商用印刷利用の確認記録あり" }] }), {
    approved: true,
    notices: [{ workId: "000015", sourceSha256: HASH, conditions: "商用印刷利用の確認記録あり" }],
  });
  assert.equal(parseCommercialRightsApproval({ approved: true, notices: [] }), null);
  assert.equal(parseCommercialRightsApproval({ approved: false, notices: [{ workId: "000015", sourceSha256: HASH, conditions: "x" }] }), null);
  assert.equal(parseCommercialRightsApproval({ approved: true, notices: [{ workId: "1", sourceSha256: HASH, conditions: " " }] }), null);
  assert.equal(parseCommercialRightsApproval({ approved: true, notices: [{ workId: "1", sourceSha256: HASH, conditions: "ok", secret: "no" }] }), null);
});

test("public build never accepts legacy buyer-supplied print assets", () => {
  assert.equal(isLegacyBuyerAssetFlowEnabled({ NODE_ENV: "production" }), false);
  assert.equal(isLegacyBuyerAssetFlowEnabled({ NODE_ENV: "development" }), true);
  assert.equal(isLegacyBuyerAssetFlowEnabled({ NODE_ENV: "test" }), true);
});

test("official A/B/C rights status is separate from edition verification and keeps legacy approvals", async () => {
  const legacyMigration = await read("supabase/migrations/20261118000100_work_commercial_rights_ledger.sql");
  const migration = await read("supabase/migrations/20261121000100_aozora_official_rights_status.sql");
  const orderRoute = await read("app/api/orders/route.ts");
  const checkout = await read("app/api/orders/[id]/checkout/route.ts");
  assert.match(legacyMigration, /rights\.source_sha256 = target_work ->> 'sourceSha256'/);
  assert.match(legacyMigration, /rights\.rights_reviews_complete/);
  assert.match(migration, /classification.*'A'/s);
  assert.match(migration, /workCopyrightFlags/);
  assert.match(migration, /catalogPersonCopyrightFlags/);
  assert.match(migration, /set_amuhon_work_rights_manual_stop_v1/);
  assert.match(migration, /_amuhon_work_rights_manual_stop_active_v1\(target_work ->> 'id'\)/);
  assert.match(migration, /get_amuhon_order_rights_snapshot_v1/);
  assert.match(orderRoute, /resolveAozoraWorkEditionsWithCatalog\(bookSelection\.workIds, fetch, true\)/);
  assert.match(orderRoute, /work\.catalogRights !== undefined/);
  assert.match(orderRoute, /p_works: rightsWorks/);
  assert.match(orderRoute, /notice\.sourceSha256 !== work\.sourceSha256/);
  assert.match(orderRoute, /notice\.conditions !== AOZORA_ATTRIBUTION_NOTICE/);
  assert.match(orderRoute, /approval\.notices/);
  assert.match(checkout, /check_amuhon_order_commercial_rights_v1/);
  assert.match(checkout, /get_amuhon_order_rights_snapshot_v1/);
  assert.match(checkout, /stored\.sourceSha256 !== current\.sourceSha256/);
  assert.match(checkout, /sameAozoraRightsFacts/);
  assert.doesNotMatch(migration, /insert into public\.amuhon_work_commercial_rights/i);
});

test("printing rights notices enter from server ledger and appear in endmatter", async () => {
  const [orderRoute, sourcePage, localParser] = await Promise.all([
    read("app/api/orders/route.ts"),
    read("app/final/page.tsx"),
    read("lib/local-order-pdf-request.ts"),
  ]);
  assert.match(orderRoute, /resolveAozoraWorkEditionsWithCatalog\(bookSelection\.workIds, fetch, true\)/);
  assert.match(orderRoute, /sourceSha256: notice\.sourceSha256, rightsNotice: notice\.conditions/);
  assert.match(sourcePage, /青空文庫作成ファイル：\{work\.rightsNotice\}/);
  assert.match(sourcePage, /利用条件：\{work\.rightsNotice\}/);
  assert.match(localParser, /work\.rightsNotice/);
});
