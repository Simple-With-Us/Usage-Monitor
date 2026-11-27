import test from 'node:test';
import assert from 'node:assert/strict';
import { appRelevant, classifyDelta, APP_WATCH_PATHS, qualifyAppPolicy } from './production-observer-eligibility.mjs';
const old = '1'.repeat(40), expected = '2'.repeat(40);
const classify = (paths, extras = {}) => classifyDelta({ observed: old, expected, qualifiedPatterns: true,
  isAncestor: (a, b) => b === 'refs/remotes/origin/main' || a === old && b === expected,
  changedPaths: () => paths, ...extras });
test('every configured exact path and recursive app directory requires observation', () => {
  for (const pattern of APP_WATCH_PATHS) {
    const path = pattern.endsWith('/**') ? pattern.slice(0, -2) + 'nested/change.ts' : pattern;
    assert.equal(appRelevant(path), true, path);
    assert.deepEqual(classify([path]), { observe: true, reason: 'app-relevant-change' });
  }
});
test('qualified non-app changes produce only non-deployment result', () => {
  for (const path of ['.github/workflows/sentry-deploy.yml', 'scripts/sentry-report-deploy.mjs', 'ios/UsageMonitor/File.swift', 'workers/receipt-inbox/src/index.mjs', 'docs/example.md', 'tests/e2e/visual.spec.ts']) {
    const result = classify([path]);
    assert.equal(result.observe, false);
    assert.equal(result.reason, 'non-app-delta');
    assert.equal(result.expected, expected);
    assert.equal(result.observed, old);
    assert.equal(result.deployId, undefined);
  }
});
test('mixed delta and either side of rename into app paths require observation', () => {
  for (const paths of [['docs/note.md', 'src/app/page.tsx'], ['docs/old.md', 'src/new.ts'], ['src/old.ts', 'docs/new.md']]) assert.equal(classify(paths).observe, true);
});
test('unqualified parity cannot authorize skip', () => {
  assert.throws(() => classify(['docs/note.md'], { qualifiedPatterns: false }), /parity/);
});
test('empty, malformed, unrelated or failed diff evidence never authorizes skip', () => {
  for (const paths of [[], null, [''], [null], ['/absolute'], ['a\0b']]) assert.throws(() => classify(paths));
  assert.throws(() => classify(['docs/note.md'], { changedPaths: () => { throw new Error('truncated'); } }));
  assert.throws(() => classify(['docs/note.md'], { isAncestor: () => false }));
  assert.throws(() => classify(['docs/note.md'], { expected: 'short' }));
});
test('unknown patterns or empty watch policy cannot authorize skip', () => {
  for (const patterns of [[], ['*.js'], ['../x'], ['/src/**'], ['src/?'], ['src/[ab]'], ['src/{a,b}']]) assert.throws(() => classify(['docs/note.md'], { patterns }));
});
test('already adopted revision still requires strict health observation', () => {
  assert.equal(classify([], { observed: expected }).observe, true);
});

test('runtime parity binds exact app source and every live watch path', () => {
  const app = { uuid: 'yagelvqux9e8l1kztif7bf2o', git_branch: 'main', git_commit_sha: 'HEAD', git_repository: 'git@github.com:Simple-With-Us/Usage-Monitor.git', settings: { is_auto_deploy_enabled: true }, watch_paths: APP_WATCH_PATHS.join('\n') };
  assert.equal(qualifyAppPolicy(app), true);
  for (const patch of [ {uuid:'other'}, {git_branch:'other'}, {git_commit_sha:old}, {git_repository:'other'}, {settings:{is_auto_deploy_enabled:false}}, {watch_paths:APP_WATCH_PATHS.slice(1).join('\n')}, {watch_paths:app.watch_paths+'\nnew-path'}, {watch_paths:app.watch_paths+'\nDockerfile'} ]) assert.throws(() => qualifyAppPolicy({...app,...patch}));
});

test('both workflows use eligibility without changing strict release verification', async () => {
  const {readFileSync} = await import('node:fs');
  const sentry = readFileSync(new URL('../.github/workflows/sentry-deploy.yml', import.meta.url),'utf8');
  const production = readFileSync(new URL('../.github/workflows/production-deploy-verify.yml', import.meta.url),'utf8');
  for (const workflow of [sentry,production]) {
    assert.match(workflow,/INFISICAL_SECRET_PATH: \/um-observer-policy/);
    assert.match(workflow,/INFISICAL_UM_OBSERVER_POLICY_READ_TOKEN/);
    assert.match(workflow,/id: app-policy/);
    assert.match(workflow,/steps.app-policy.outputs.observe != 'false'/);
    assert.match(workflow,/node scripts\/production-observer-eligibility.mjs/);
  }
  assert.match(sentry,/run: node scripts\/sentry-report-deploy.mjs/);
  assert.match(production,/\.revision == \$revision/);
  assert.match(production,/\.checks.scheduler.lastTickSucceeded == true/);
});
