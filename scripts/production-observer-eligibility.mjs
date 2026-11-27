import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONFIG, readIdentity } from './sentry-report-deploy.mjs';

export const APP_WATCH_PATHS = Object.freeze(JSON.parse(readFileSync(new URL('./production-app-watch-paths.json', import.meta.url), 'utf8')));
const SHA = /^[0-9a-f]{40}$/;
const AppPolicySchema = z.object({ uuid: z.string(), git_branch: z.string(), git_commit_sha: z.string(), git_repository: z.string(), watch_paths: z.string(), settings: z.object({ is_auto_deploy_enabled: z.boolean() }) });

// Coolify's configured patterns here are exact paths and recursive directory
// prefixes only. Unknown pattern shapes cannot authorize a non-deployment skip.
export function appRelevant(path, patterns = APP_WATCH_PATHS) {
  if (!Array.isArray(patterns) || !patterns.length) throw new Error('Unqualified app watch paths');
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.includes('..') || /[?\[\]{}!]/.test(pattern)) throw new Error('Unqualified app watch pattern');
    if (pattern.endsWith('/**') && !pattern.slice(0, -3).includes('*')) return path.startsWith(pattern.slice(0, -2));
    if (pattern.includes('*')) throw new Error('Unqualified app watch pattern');
    return path === pattern;
  });
}

export function classifyDelta({ observed, expected, isAncestor, changedPaths, patterns = APP_WATCH_PATHS, qualifiedPatterns = false }) {
  if (!SHA.test(observed || '') || !SHA.test(expected || '')) throw new Error('Full revisions required');
  if (!isAncestor(observed, 'refs/remotes/origin/main') || !isAncestor(expected, 'refs/remotes/origin/main')) throw new Error('Revision is not on main');
  if (observed === expected || isAncestor(expected, observed)) return { observe: true, reason: 'live-revision-adopted' };
  if (!isAncestor(observed, expected)) throw new Error('Unrelated revision history');
  if (!qualifiedPatterns) throw new Error('App watch-path parity not qualified');
  const paths = changedPaths(observed, expected);
  if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0'))) throw new Error('Incomplete changed-path evidence');
  // Evaluate every pattern even when an earlier match would short-circuit.
  for (const pattern of patterns) appRelevant('qualification-probe', [pattern]);
  if (paths.some((path) => appRelevant(path, patterns))) return { observe: true, reason: 'app-relevant-change' };
  return { observe: false, reason: 'non-app-delta', observed, expected, paths };
}

export function qualifyAppPolicy(input) {
  const app = AppPolicySchema.parse(input);
  const expected = APP_WATCH_PATHS;
  if (app?.uuid !== 'yagelvqux9e8l1kztif7bf2o' || app.git_branch !== 'main' || app.git_commit_sha !== 'HEAD' || app.git_repository !== 'git@github.com:Simple-With-Us/Usage-Monitor.git' || app.settings?.is_auto_deploy_enabled !== true || typeof app.watch_paths !== 'string') throw new Error('App policy identity mismatch');
  const actual = app.watch_paths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((path) => !actual.includes(path))) throw new Error('App watch-path policy drift');
  return true;
}

export async function readPolicyResponse(response) {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const length = response.headers.get('content-length');
  if (!response.ok || !type || (type !== 'application/json' && !type.endsWith('+json')) || (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536))) throw new Error('App policy response unavailable');
  if (!response.body) throw new Error('App policy response unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('App policy response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (size === 0) throw new Error('App policy response unavailable');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

export async function classifyProduction({ expected = process.env.EXPECTED_SHA || process.env.TARGET_SHA, exec = execFileSync, fetchImpl = fetch } = {}) {
  const token = process.env.COOLIFY_UM_OBSERVER_READ_TOKEN;
  if (!token?.trim()) throw new Error('Missing COOLIFY_UM_OBSERVER_READ_TOKEN');
  const response = await fetchImpl('https://host.jays.services/api/v1/applications/yagelvqux9e8l1kztif7bf2o', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('COOLIFY_UM_OBSERVER_READ_TOKEN app policy read failed');
  const qualifiedPatterns = qualifyAppPolicy(await readPolicyResponse(response));
  const origin = process.env.PRODUCTION_ORIGIN_IPV4;
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(origin || '')) throw new Error('Production origin is required');
  const url = new URL(CONFIG.health);
  url.searchParams.set('eligibility-probe', String(Date.now()));
  const body = JSON.parse(exec('curl', ['-fsS', '--max-time', '15', '--resolve', `${url.hostname}:443:${origin}`, '-H', 'Cache-Control: no-cache, no-store', url.toString()], { encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 }));
  const observed = readIdentity(body);
  exec('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: 30000 });
  const isAncestor = (a, b) => {
    try { exec('git', ['merge-base', '--is-ancestor', a, b], { timeout: 30000, stdio: 'ignore' }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  return classifyDelta({ observed, expected, isAncestor, qualifiedPatterns, changedPaths: (a, b) => {
    // Inspect every first-parent change, not the net diff: an app change
    // subsequently reverted still triggered deployment. Disable rename
    // detection so both sides of a move are classified.
    const raw = exec('git', ['log', '--first-parent', '--diff-merges=first-parent', '--format=', '--no-renames', '--name-only', '-z', `${a}..${b}`, '--'], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (!raw.endsWith('\0')) throw new Error('Incomplete changed-path evidence');
    return raw.slice(0, -1).split('\0');
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Any unavailable health/history/diff/pattern evidence leaves strict observation
  // enabled. It never turns an unknown revision into a deployment or a skip.
  let result;
  try { result = await classifyProduction(); }
  catch { result = { observe: true, reason: 'eligibility-unverified-strict-observation-required' }; }
  const summary = result.observe
    ? `App deployment observation required (${result.reason}).\n`
    : `Non-deployment: only non-app paths differ between live ${result.observed} and CI ${result.expected}. No deployment verified and no Sentry annotation written.\n`;
  console.log(summary.trim());
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `observe=${result.observe}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
