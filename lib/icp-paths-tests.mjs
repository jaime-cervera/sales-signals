#!/usr/bin/env node

/**
 * lib/icp-paths-tests.mjs — tests for the ICP path-resolution layer (Unit 1.1).
 *
 * Exhaustive because `lib/icp-paths.mjs` is the central seam for multi-ICP
 * scoping: every mode resolves its paths through it, and the R7 isolation
 * invariant ("operating on ICP A never reads/writes ICP B") rests on it never
 * returning a path outside `icps/<slug>/`. Registered in test-all.mjs scripts[].
 */

import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import {
  resolveIcpPaths, applyEnv, listIcps, isValidSlug, ENV_BY_KEY,
} from './icp-paths.mjs';

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

// Throwaway root with three seeded ICP dirs (existence is all the resolver checks).
const root = mkdtempSync(join(tmpdir(), 'co-icp-'));
for (const slug of ['default', 'acme', 'globex']) {
  mkdirSync(join(root, 'icps', slug), { recursive: true });
}

// ── Happy path: every returned path lives under icps/<slug>/ ────────────────
{
  const p = resolveIcpPaths('acme', { root });
  const under = join(root, 'icps', 'acme') + sep;
  const pathKeys = Object.keys(ENV_BY_KEY); // the env-mapped path keys
  const allUnder = pathKeys.every(k => (p[k] + sep).startsWith(under) || p[k] === join(root, 'icps', 'acme'));
  ok(allUnder, 'resolveIcpPaths("acme") returns only paths under icps/acme/');
  ok(p.portals === join(root, 'icps', 'acme', 'signals.yml'), 'portals key → icps/acme/signals.yml');
  ok(p.tracker === join(root, 'icps', 'acme', 'prospects.md'), 'tracker → icps/acme/prospects.md');
  ok(p.icp === join(root, 'icps', 'acme', 'icp.md'), 'icp → icps/acme/icp.md');
  ok(p.reports === join(root, 'icps', 'acme', 'reports'), 'reports → icps/acme/reports');
  ok(p.slug === 'acme', 'slug echoed back');
}

// ── Edge: no slug + no env → default ───────────────────────────────────────
{
  const p = resolveIcpPaths(undefined, { root, env: {} });
  ok(p.slug === 'default', 'no slug + no env → default');
  ok(p.tracker === join(root, 'icps', 'default', 'prospects.md'), 'default tracker → icps/default/prospects.md');
}

// ── Edge: CAREER_OPS_ICP env selects the ICP when no arg ───────────────────
{
  const p = resolveIcpPaths(undefined, { root, env: { CAREER_OPS_ICP: 'globex' } });
  ok(p.slug === 'globex', 'CAREER_OPS_ICP=globex (no arg) → globex');
}

// ── Edge: explicit arg beats env ───────────────────────────────────────────
{
  const p = resolveIcpPaths('acme', { root, env: { CAREER_OPS_ICP: 'globex' } });
  ok(p.slug === 'acme', 'explicit arg "acme" beats env "globex"');
}

// ── Error: unknown slug throws, listing available ICPs ─────────────────────
{
  let threw = false, msg = '';
  try { resolveIcpPaths('nope', { root }); } catch (e) { threw = true; msg = e.message; }
  ok(threw, 'unknown slug throws');
  ok(/acme/.test(msg) && /globex/.test(msg) && /default/.test(msg),
    'unknown-slug error lists available ICPs (acme, globex, default)');
}

// ── Edge: path-traversal / unsafe slugs are rejected before any path build ──
for (const bad of ['../foo', '..', 'a/b', 'a\\b', 'Acme', 'with space', '', '.hidden', '/abs']) {
  ok(!isValidSlug(bad), `isValidSlug rejects unsafe slug ${JSON.stringify(bad)}`);
  let threw = false;
  try { resolveIcpPaths(bad, { root }); } catch { threw = true; }
  ok(threw, `resolveIcpPaths rejects unsafe slug ${JSON.stringify(bad)} (no path escape)`);
}
ok(isValidSlug('default') && isValidSlug('retail-co') && isValidSlug('icp1'),
  'isValidSlug accepts kebab slugs (default, retail-co, icp1)');

// ── applyEnv sets every CAREER_OPS_* var + CAREER_OPS_ICP ───────────────────
{
  const env = {};
  const p = resolveIcpPaths('globex', { root });
  applyEnv(p, { env });
  let allSet = true;
  for (const [key, varName] of Object.entries(ENV_BY_KEY)) {
    if (env[varName] !== p[key]) { allSet = false; fail(`applyEnv sets ${varName}`); }
  }
  if (allSet) pass('applyEnv sets every CAREER_OPS_* path var');
  ok(env.CAREER_OPS_ICP === 'globex', 'applyEnv sets CAREER_OPS_ICP to the slug');
}

// ── listIcps reflects the seeded dirs (sorted, dirs only) ──────────────────
{
  const list = listIcps({ root });
  ok(JSON.stringify(list) === JSON.stringify(['acme', 'default', 'globex']),
    'listIcps returns the seeded ICP dirs, sorted');
  ok(JSON.stringify(listIcps({ root: join(root, 'nonexistent') })) === '[]',
    'listIcps on a root without icps/ returns []');
}

// ── mustExist:false allows pure path computation (used by --create-icp) ─────
{
  const p = resolveIcpPaths('brand-new', { root, mustExist: false });
  ok(p.slug === 'brand-new' && p.dir === join(root, 'icps', 'brand-new'),
    'mustExist:false computes paths for a not-yet-created ICP without throwing');
}

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
