import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const sqlUrl = new URL("supabase/rights-review/20261120_initial_candidate_records.sql", ROOT);
const docUrl = new URL("docs/RIGHTS_LEDGER_INITIAL_CANDIDATES_20261120.md", ROOT);

test("initial rights-ledger candidate draft is fail-closed and keeps all entries pending", async () => {
  const [sql, doc] = await Promise.all([
    readFile(sqlUrl, "utf8"),
    readFile(docUrl, "utf8"),
  ]);

  assert.match(sql, /raise exception 'Review-only rights candidate draft/);
  assert.equal((sql.match(/'B'/g) ?? []).length, 6);
  assert.equal((sql.match(/NULL::timestamptz/g) ?? []).length, 6);
  assert.equal((sql.match(/NULL::text/g) ?? []).length, 6);
  assert.equal((sql.match(/\n\s+false,\n/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /'A'/);
  assert.match(sql, /on conflict \(work_id, xhtml_url, source_sha256\) do nothing/i);
  assert.match(sql, /on conflict \(work_id, xhtml_url, source_sha256, person_name, role\) do nothing/i);

  for (const [id, hash] of [
    ["000799", "d92a8aa62607a8269324f95a7ba8fe6ff71cd56de25b42af566679832109ff04"],
    ["001927", "39bae724600360fbeb24f8fb0af7c9090bb4ab206139955b9d1a2c67a1527a45"],
    ["000042", "646d4948414bc1d231375208421342657b82206f71979eac541f1e8f8b561174"],
  ]) {
    assert.match(sql, new RegExp(`'${id}'`));
    assert.match(sql, new RegExp(hash));
    assert.match(doc, new RegExp(hash));
  }
  assert.match(doc, /3作品ともB（要確認）/);
  assert.match(doc, /一部.*目安.*網羅的・完全ではない/);
});
