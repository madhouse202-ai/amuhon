import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { filterAozoraWorksByApprovedScope } from "../lib/aozora-rights-scope.ts";
import { GET as worksGet } from "../app/api/works/route.ts";
import {
  CURRENT_AOZORA_RIGHTS_POLICY,
  calculateAozoraRightsPolicySha256,
  calculateAozoraRightsWorkFactsSha256,
  isCurrentAozoraRightsPolicyReady,
  parseAozoraSellableWorkFacts,
} from "../lib/aozora-rights-policy.ts";

const ROOT = new URL("../", import.meta.url);

function work(id = "799", overrides = {}) {
  return {
    id, title: "夢十夜", titleReading: "ゆめじゅうや", sortReading: "ゆめじゅうや", author: "夏目 漱石",
    cardUrl: "https://www.aozora.gr.jp/cards/000148/card799.html",
    textUrl: "https://www.aozora.gr.jp/cards/000148/files/799_ruby_14972.zip",
    xhtmlUrl: "https://www.aozora.gr.jp/cards/000148/files/799_14972.html",
    contributors: [{ name: "夏目 漱石", role: "著者", reading: "なつめ そうせき", personIds: ["000148"], copyrightFlags: ["なし"], missingCopyrightFlagRows: 0 }],
    sourceMetadata: { firstPublication: "初出", baseText: "底本", basePublisher: "出版社", inputter: "入力者", proofreader: "校正者" },
    workCopyrightFlags: ["なし"], missingWorkCopyrightFlagRows: 0, catalogPersonCopyrightFlags: ["なし"],
    missingPersonCopyrightFlagRows: 0, incompleteContributorRows: 0, sourceMetadataConflicts: [], catalogIssues: [], catalogRowCount: 1,
    ...overrides,
  };
}

test("the checked-in policy remains draft/unconfirmed and cannot authorize browsing or sales", () => {
  assert.equal(CURRENT_AOZORA_RIGHTS_POLICY.status, "draft");
  assert.equal(CURRENT_AOZORA_RIGHTS_POLICY.legalReviewStatus, "unconfirmed");
  assert.equal(isCurrentAozoraRightsPolicyReady(), false);
});

test("policy readiness requires complete common criteria and timestamped operator/legal records", () => {
  const original = structuredClone(CURRENT_AOZORA_RIGHTS_POLICY);
  try {
    Object.assign(CURRENT_AOZORA_RIGHTS_POLICY, {
      status: "active", legalReviewStatus: "confirmed", approvedBy: "合成テスト運営者",
      approvedAt: "2026-11-20T12:00:00+09:00", legalReviewedBy: "合成テスト確認者",
      legalReviewedAt: "2026-11-20T11:00:00+09:00", legalReviewEvidence: "合成データ上の確認記録",
    });
    assert.equal(isCurrentAozoraRightsPolicyReady(), true);
    const criteria = CURRENT_AOZORA_RIGHTS_POLICY.humanReviewRequirements;
    CURRENT_AOZORA_RIGHTS_POLICY.humanReviewRequirements = [];
    assert.equal(isCurrentAozoraRightsPolicyReady(), false);
    CURRENT_AOZORA_RIGHTS_POLICY.humanReviewRequirements = criteria;
    CURRENT_AOZORA_RIGHTS_POLICY.approvedAt = "not-a-time";
    assert.equal(isCurrentAozoraRightsPolicyReady(), false);
  } finally {
    Object.assign(CURRENT_AOZORA_RIGHTS_POLICY, original);
  }
});

test("sellable scope parser rejects malformed, duplicate, and unbounded entries", () => {
  assert.deepEqual(parseAozoraSellableWorkFacts([{ workId: "799", factsSha256: "a".repeat(64) }]), [
    { workId: "799", factsSha256: "a".repeat(64) },
  ]);
  assert.equal(parseAozoraSellableWorkFacts([{ workId: "799", factsSha256: "bad" }]), null);
  assert.equal(parseAozoraSellableWorkFacts([
    { workId: "799", factsSha256: "a".repeat(64) }, { workId: "799", factsSha256: "b".repeat(64) },
  ]), null);
});

test("catalog display requires official A plus an exact scoped work-facts digest", () => {
  const eligible = work();
  const protectedWork = work("800", { workCopyrightFlags: ["あり"] });
  const scope = [
    { workId: eligible.id, factsSha256: calculateAozoraRightsWorkFactsSha256(eligible) },
    { workId: protectedWork.id, factsSha256: calculateAozoraRightsWorkFactsSha256(protectedWork) },
    { workId: "801", factsSha256: "c".repeat(64) },
  ];
  assert.deepEqual(filterAozoraWorksByApprovedScope([eligible, protectedWork, work("801")], scope), [eligible]);
  const changed = work("799", { sourceMetadata: { ...eligible.sourceMetadata, baseText: "差し替わった底本" } });
  assert.notEqual(calculateAozoraRightsWorkFactsSha256(changed), scope[0].factsSha256);
  assert.deepEqual(filterAozoraWorksByApprovedScope([changed], scope), []);
});

test("the additive migration seeds exactly the current draft and gates every official decision on active scope", async () => {
  const migration = await readFile(new URL("supabase/migrations/20261128000100_aozora_common_rights_policy_scope.sql", ROOT), "utf8");
  const match = migration.match(/\$policy\$([\s\S]*?)\$policy\$::jsonb/);
  assert.ok(match, "seeded policy JSON must be inspectable");
  const seededPolicy = JSON.parse(match[1]);
  assert.deepEqual(seededPolicy, CURRENT_AOZORA_RIGHTS_POLICY);
  assert.match(migration, new RegExp(calculateAozoraRightsPolicySha256()));
  assert.match(migration, /'draft', 'unconfirmed'/);
  assert.match(migration, /selected_scope_status <> 'active'/);
  assert.match(migration, /batch\.scope_status = 'active'/);
  assert.match(migration, /unique \(batch_package_sha256\)/i);
  assert.match(migration, /grant execute on function public\.get_amuhon_aozora_sellable_work_facts_v1\(text, text, text\) to service_role/i);
  assert.match(migration, /revoke all on function public\.get_amuhon_aozora_sellable_work_facts_v1\(text, text, text\) from public, anon, authenticated, service_role/i);
  for (const table of ["amuhon_aozora_rights_policy_registry", "amuhon_aozora_rights_scope_batches", "amuhon_aozora_rights_scope_members"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, "i"));
  }
  assert.match(migration, /create or replace function public\._amuhon_aozora_work_in_approved_scope_v1[\s\S]*?stable\s+security definer\s+set search_path = pg_catalog, pg_temp/i);
  assert.match(migration, /grant execute on function public\.check_amuhon_works_commercial_rights_v1\(jsonb\) to service_role/i);
  assert.match(migration, /latest_membership as \([\s\S]*?distinct on \(member\.work_id\)[\s\S]*?order by member\.work_id, batch\.scope_id desc/i);
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test("work catalog API does not serialize rights facts and only emits records after the common scope filter", async () => {
  const route = await readFile(new URL("app/api/works/route.ts", ROOT), "utf8");
  assert.match(route, /if \(!isCurrentAozoraRightsPolicyReady\(\)\) return \{ ready: false, works: \[\] \}/);
  assert.match(route, /get_amuhon_aozora_sellable_work_facts_v1/);
  assert.match(route, /filterAozoraWorksByApprovedScope\(catalog\.works, scope\)/);
  assert.match(route, /contributors: work\.contributors\.map\(\(\{ name, role, reading \}\)/);
  assert.doesNotMatch(route, /workCopyrightFlags:\s*work\./);
});

test("an unapproved policy fails the public browse, search, and index endpoints closed", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("catalog or Supabase access is not expected"); };
  try {
    for (const query of ["browse=discover", "browse=authors", "browse=works", "q=漱石"]) {
      const response = await worksGet(new Request(`https://app.test/api/works?${query}`));
      assert.equal(response.status, 503, query);
      assert.equal("works" in await response.json(), false, query);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

