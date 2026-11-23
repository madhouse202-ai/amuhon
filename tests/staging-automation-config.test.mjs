import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(new URL("../cloudbuild.staging.yaml", import.meta.url), "utf8");
const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dockerfile = await readFile(new URL("../Dockerfile.pdf-renderer", import.meta.url), "utf8");

function stepIndex(id) {
  const match = config.match(new RegExp(`- id: ${id}\\s`));
  assert.ok(match, `missing Cloud Build step: ${id}`);
  return match.index;
}

test("staging publishing is opt-in and source is fixed to staging", () => {
  assert.match(config, /_DEPLOY_STAGING:\s*["']false["']/);
  assert.match(config, /STAGING_PROJECT_MISMATCH/);
  assert.match(config, /codex\/pdf-preview-fix-20261118/);
});

test("tests and offline renderer self-test gate publication and Job update", () => {
  const checks = stepIndex("checks");
  const build = stepIndex("build-renderer");
  const smoke = stepIndex("offline-renderer-self-test");
  const preflight = stepIndex("staging-preflight");
  const push = stepIndex("push-staging-image");
  const update = stepIndex("update-staging-job-by-digest");
  assert.ok(checks < build && build < smoke && smoke < preflight && preflight < push && push < update);
  const checksConfig = config.slice(checks, build);
  const typegen = checksConfig.indexOf("npx next typegen");
  const typecheck = checksConfig.indexOf("npx tsc --noEmit");
  assert.ok(typegen >= 0 && typecheck > typegen, "Next.js route types must be generated before TypeScript checks");
  assert.match(config, /--network=none/);
  assert.match(config, /--self-test/);
  assert.match(config, /npm run test:pdf-render-queue/);
  const pipelineScripts = [...config.matchAll(/\bnpm run ([a-z0-9:-]+)/g)].map((match) => match[1]);
  assert.ok(pipelineScripts.length > 0);
  for (const script of pipelineScripts) assert.ok(packageJson.scripts[script], `missing npm script: ${script}`);
  assert.match(dockerfile, /npm run build/);
});

test("deployment pins the resolved digest and never executes or creates a Job", () => {
  assert.match(config, /gcloud artifacts docker images describe/);
  assert.match(config, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(config, /--image="\$\$image@\$\$digest"/);
  assert.match(config, /jobs describe amuhon-order-notification-worker/);
  assert.match(config, /jobs update amuhon-order-notification-worker/);
  assert.doesNotMatch(config, /--execute-now|jobs execute|jobs create/);
});

test("build configuration does not inject worker or payment secrets", () => {
  assert.doesNotMatch(config, /SUPABASE_SECRET_KEY|STRIPE_SECRET_KEY|WEBHOOK_SECRET|\.env\.local/i);
});

test("Docker context excludes local worktrees and nested environment files", () => {
  assert.match(dockerignore, /^\.worktrees$/m);
  assert.match(dockerignore, /^\*\*\/\.worktrees$/m);
  assert.match(dockerignore, /^\*\*\/\.env\.\*$/m);
  assert.match(dockerignore, /^\.local-assets$/m);
});
