import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const migrationSpecs = [
  [
    "20261103000100_order_stripe_checkout",
    "c450a88a4a7728b13719e8cead3971384a30f45160e72369d589492c7c6fcd39",
  ],
  [
    "20261103000200_order_admin_fulfillment",
    "8e7f87ccf26b156af960c809c358a3c99dc1414f690d8ce3bd63b6a9116a6b25",
  ],
];
const baselineSpecs = [
  ["20261017000100_order_drafts", "1942af227de4e7f823ef14e031c2501865980c79d4ea0679df2ea36c8f857f69"],
  ["20261020000100_order_asset_uploads", "6ebe44db71d00407116ccde9bd35a6ade0611751bcaf046d6ec56c02ad3aa538"],
  ["20261020000200_order_asset_size_limit", "ca41c0aedcc83816588010bb7fc1d80767ac2543972c288a3194d8b03f6fdf33"],
  ["20261020000300_order_temp_uploads", "5d2a079326b1749a1bc40ec3f7de616d6575d0c4ac50c449d01d63d27448044e"],
  ["20261021000100_order_validation_jobs", "8f10bbe8cce4cb2d81a29ea6f02c66aadb38e8ad23be43c3b7d0c50938fcb995"],
  ["20261022000100_order_validation_asset_commit", "28e0b23873f02030da1162d7006478305b3843b8ca6122e44e7494dd2e58de0d"],
  ["20261025000100_order_validation_targeted_claim", "194b9d0b333556b8b2b31f3427866c0f826509267d4684b245eca2454fb789de"],
];

test("admin fulfillment audit constraint requires both audit fields together", async () => {
  const sql = await read("supabase/migrations/20261103000200_order_admin_fulfillment.sql");
  assert.match(
    sql,
    /check\s*\(\s*\(printer_submitted_at is null\)\s*=\s*\(printer_submitted_by is null\)\s+and\s+\(printer_submission_status = 'submitted'\)\s*=\s*\(printer_submitted_at is not null and printer_submitted_by is not null\)\s*\)/i,
  );
});

test("the two reviewed migrations are transaction compatible and their approved hashes match", async () => {
  const apply = await read("scripts/native-postgres/apply-order-checkout-native.ps1");
  for (const [version, approvedHash] of migrationSpecs) {
    const bytes = await readFile(new URL(`supabase/migrations/${version}.sql`, ROOT));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash, approvedHash, `${version} reviewed digest`);
    assert.ok(apply.includes(`'${version}' = '${approvedHash}'`), `${version} pinned in wrapper`);
    const sql = bytes.toString("utf8");
    assert.doesNotMatch(sql, /^\s*\\/m, `${version} has no psql meta-command`);
    assert.doesNotMatch(sql, /^\s*(?:begin|commit|rollback)\s*;/im, `${version} has no transaction control`);
    assert.doesNotMatch(sql, /\b(?:create\s+(?:unique\s+)?index\s+concurrently|vacuum|cluster)\b/i);
  }
});

test("the append wrapper's read-only baseline verification matches the existing seven approved source files", async () => {
  const apply = await read("scripts/native-postgres/apply-order-checkout-native.ps1");
  for (const [version, approvedHash] of baselineSpecs) {
    const bytes = await readFile(new URL(`supabase/migrations/${version}.sql`, ROOT));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), approvedHash, `${version} baseline digest`);
    assert.match(apply, new RegExp(`Version = '${version}'; Hash = '${approvedHash}'`));
  }
  assert.match(apply, /foreach \(\$entry in \$baseline\)[\s\S]*?baseline SHA-256 mismatch/i);
});

test("checkout migration wrapper fixes NativeRoot before preflight and passes only the canonical path", async () => {
  const apply = await read("scripts/native-postgres/apply-order-checkout-native.ps1");
  const pathSafety = await read("scripts/native-postgres/native-postgres-path-safety.psm1");
  const normalizeIndex = apply.indexOf("$rootPath = Assert-NativeLocalDrivePath $NativeRoot");
  const exactCompareIndex = apply.indexOf("Test-CanonicalPathEqual $rootPath 'C:\\amuhon-native-pg'");
  const reparseCheckIndex = apply.indexOf("Assert-NoReparsePath $rootPath");
  const preflightIndex = apply.indexOf("& $preflight -NativeRoot $rootPath -PreflightOnly");
  assert.ok(normalizeIndex >= 0 && exactCompareIndex > normalizeIndex, "normalization precedes exact comparison");
  assert.ok(reparseCheckIndex > exactCompareIndex && preflightIndex > reparseCheckIndex, "reparse check completes before shared preflight");
  assert.doesNotMatch(apply, /& \$preflight -NativeRoot \$NativeRoot/);
  assert.match(pathSafety, /GetFullPath\(\$expandedPath\)/);
  assert.match(pathSafety, /TrimEnd\(/);
  assert.match(pathSafety, /StringComparison\]::OrdinalIgnoreCase/);
  assert.match(pathSafety, /UNC and device paths are not accepted/);
});

test("append-only native wrapper requires the guarded seven-file baseline and applies only the two new files atomically", async () => {
  const apply = await read("scripts/native-postgres/apply-order-checkout-native.ps1");
  const baselineRunner = await read("scripts/native-postgres/apply-order-validation-native.ps1");
  const versionsBlock = apply.match(/\$versions\s*=\s*@\(([\s\S]*?)\n\)/)?.[1] ?? "";
  assert.deepEqual(
    [...versionsBlock.matchAll(/'((?:2026)[0-9]+_[a-z0-9_]+)'/g)].map((match) => match[1]),
    migrationSpecs.map(([version]) => version),
  );
  assert.match(apply, /test-order-validation-native\.ps1'[\s\S]*?-PreflightOnly/);
  assert.match(apply, /'127\.0\.0\.1'[\s\S]*?'55432'[\s\S]*?'postgres'[\s\S]*?'amuhon_validation_native'/);
  assert.match(apply, /current_database\(\) is distinct from 'amuhon_validation_native'/i);
  assert.match(apply, /current_user is distinct from 'postgres'/i);
  assert.match(apply, /inet_server_addr\(\) is distinct from inet '127\.0\.0\.1'/i);
  assert.match(apply, /pg_control_system\(\)/i);
  assert.match(apply, /data_directory/i);
  assert.match(apply, /migration ledger is not exactly the approved seven-file baseline/i);
  assert.match(apply, /checkout_migration_history/);
  assert.match(apply, /final native migration ledgers do not match the approved seven-plus-two files/i);
  assert.match(apply, /insert into native_test\.checkout_migration_history/i);
  assert.match(apply, /native_test\.migration_history\) <> 7/);
  assert.match(apply, /checkout\/admin schema objects already exist/i);
  assert.match(apply, /if exists \(select 1 from public\.amuhon_orders\)/i);
  assert.match(apply, /'-1'[\s\S]*?'-W'[\s\S]*?'-f', \$wrapperPath/);
  assert.match(apply, /ON_ERROR_STOP=1/);
  assert.match(apply, /\$LASTEXITCODE -ne 0[\s\S]*?do not assume success or rerun/i);
  assert.match(apply, /finally\s*\{[\s\S]*?Restore-NativeEnvironment[\s\S]*?Remove-Item/i);
  assert.doesNotMatch(apply, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(apply, /\b(?:initdb|reset|drop database|supabase db reset)\b/i);

  for (const [version, hash] of baselineSpecs) {
    assert.ok(apply.includes(`Version = '${version}'; Hash = '${hash}'`), `${version} baseline ledger pin`);
    assert.ok(baselineRunner.includes(`'${version}' = '${hash}'`), `${version} remains in the original first-seven wrapper`);
  }
  for (const [version, hash] of migrationSpecs) {
    assert.ok(!baselineRunner.includes(version), "new migration wrapper does not alter the fixed seven-file batch");
    assert.ok(apply.includes(hash));
  }
});

test("all SECURITY DEFINER routines keep fixed search_path and explicit revoke/grant pairs", async () => {
  for (const path of [
    "supabase/migrations/20261103000100_order_stripe_checkout.sql",
    "supabase/migrations/20261103000200_order_admin_fulfillment.sql",
  ]) {
    const sql = await read(path);
    const definitions = [...sql.matchAll(/create or replace function public\.([a-z0-9_]+)\(([\s\S]*?\n\$\$;)/gi)];
    for (const [, name, definition] of definitions) {
      assert.match(definition, /security definer/i, `${name} is definer`);
      assert.match(definition, /set search_path = pg_catalog, pg_temp/i, `${name} has a fixed search path`);
      const tail = sql.slice(sql.indexOf(definition) + definition.length);
      const accessStatements = tail.match(/^\s*revoke all on function public\.[\s\S]*?;\s*grant execute on function public\.[\s\S]*?;/i)?.[0] ?? "";
      assert.match(
        accessStatements,
        new RegExp(`^\\s*revoke all on function public\\.${name}\\([\\s\\S]*? from public, anon, authenticated(?:, service_role)?;\\s*grant execute on function public\\.${name}\\([\\s\\S]*? to service_role;$`, "i"),
        `${name} revokes browser roles and grants execute only to service_role`,
      );
    }
  }
});
