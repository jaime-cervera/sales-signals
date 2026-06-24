#!/usr/bin/env node

/**
 * scaffold-icp-tests.mjs — tests for ICP scaffolding + on-the-fly creation
 * (Unit 2.3). Registered in test-all.mjs scripts[].
 */

import { spawnSync } from 'child_process';
import {
  mkdtempSync, existsSync, readFileSync, readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { scaffoldIcp, normalizeSlug } from './scaffold-icp.mjs';
import { validateSignalsConfig } from './validate-signals.mjs';
import { loadProviderIds } from './validate-portals.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(ROOT, 'bin', 'signals.mjs');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

const providerIds = await loadProviderIds();
const root = mkdtempSync(join(tmpdir(), 'co-scaffold-'));

function runLauncher(args, dataRoot) {
  const res = spawnSync(NODE, [LAUNCHER, ...args], {
    cwd: ROOT, env: { ...process.env, CAREER_OPS_ROOT: dataRoot }, encoding: 'utf-8', timeout: 30000,
  });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// ── Happy: scaffold creates a valid, validator-passing ICP ─────────────────
{
  const { slug, dir } = scaffoldIcp({ slug: 'retailco', root });
  ok(slug === 'retailco' && existsSync(dir), 'scaffoldIcp creates icps/retailco/');
  for (const f of ['signals.yml', 'icp.md', 'config/profile.yml',
    'prospects.md', 'pipeline.md', 'scan-history.tsv', 'reports/.gitkeep']) {
    ok(existsSync(join(dir, ...f.split('/'))), `scaffold writes ${f}`);
  }
  const cfg = yaml.load(readFileSync(join(dir, 'signals.yml'), 'utf-8'));
  const res = await validateSignalsConfig(cfg, { providerIds });
  ok(res.errors.length === 0, `scaffolded signals config validates (0 errors; got ${res.errors.length})`);
}

// ── Error: re-scaffolding without --force refuses (no clobber) ─────────────
{
  let threw = false;
  try { scaffoldIcp({ slug: 'retailco', root }); } catch { threw = true; }
  ok(threw, 'scaffolding an existing slug without --force refuses (no clobber)');
}

// ── Edge: slug normalization + traversal rejection ─────────────────────────
{
  ok(normalizeSlug('Retail Co!!') === 'retail-co', 'normalizeSlug "Retail Co!!" → "retail-co"');
  ok(normalizeSlug('  ACME corp ') === 'acme-corp', 'normalizeSlug trims + kebabs');
  let threw = false;
  try { normalizeSlug('../../etc'); } catch { threw = true; }
  // "../../etc" → "etc" after stripping non-alnum, which is valid; ensure no traversal survives.
  const safe = normalizeSlug('../../etc');
  ok(safe === 'etc' && !safe.includes('.') && !safe.includes('/'),
    'normalizeSlug strips path traversal characters (no "/" or "." survives)');
}

// ── Integration: scaffolded ICP is immediately usable by the launcher ──────
{
  const r = runLauncher(['verify', '--icp', 'retailco'], root);
  ok(r.code === 0, 'verify --icp retailco runs on the freshly scaffolded ICP (exit 0)');
}

// ── Integration: --create-icp scaffolds then runs in one shot ──────────────
{
  const r = runLauncher(['verify', '--icp', 'brandnew', '--create-icp'], root);
  ok(r.code === 0 && existsSync(join(root, 'icps', 'brandnew')),
    '--create-icp scaffolds "brandnew" then runs verify (exit 0)');
}

// ── Integration: --create-icp twice with a non-kebab name both exit 0 ──────
{
  // The raw --icp "Mixed Case" normalizes to "mixed-case". The first run
  // scaffolds it; the SECOND run hits the already-exists branch, which must
  // normalize the slug before resolving (else resolveIcpPaths throws
  // "Invalid ICP slug" for an ICP that exists).
  const r1 = runLauncher(['verify', '--icp', 'Mixed Case', '--create-icp'], root);
  ok(r1.code === 0 && existsSync(join(root, 'icps', 'mixed-case')),
    'first --create-icp "Mixed Case" scaffolds mixed-case and runs (exit 0)');
  const r2 = runLauncher(['verify', '--icp', 'Mixed Case', '--create-icp'], root);
  ok(r2.code === 0, 're-run --create-icp "Mixed Case" on the existing ICP exits 0 (no Invalid-slug crash)');
}

// ── Integration: unknown slug WITHOUT --create-icp errors, no scaffolding ──
{
  const before = readdirSync(join(root, 'icps')).sort().join(',');
  const r = runLauncher(['verify', '--icp', 'ghost'], root);
  const after = readdirSync(join(root, 'icps')).sort().join(',');
  ok(r.code !== 0 && !existsSync(join(root, 'icps', 'ghost')) && before === after,
    'unknown slug without --create-icp errors and does NOT scaffold');
}

// ── Structural: modes/icp.md is coherent (references the scaffolder + validator
//    + captures the required fields). The full golden-output behaviour is the
//    agent-eval fixture test/agent-evals/icp-onboarding.md (needs an agent). ──
{
  const mode = readFileSync(join(ROOT, 'modes', 'icp.md'), 'utf-8');
  ok(/scaffold-icp\.mjs/.test(mode), 'icp mode references scaffold-icp.mjs');
  ok(/validate-signals\.mjs/.test(mode), 'icp mode references validate-signals.mjs');
  ok(/title_filter\.positive/.test(mode) && /[Dd]ecision-?[Mm]aker/.test(mode) && /[Ff]irmographics/.test(mode),
    'icp mode captures the required ICP fields (signals, firmographics, decision-makers)');
  const evalFixture = readFileSync(join(ROOT, 'test', 'agent-evals', 'icp-onboarding.md'), 'utf-8');
  ok(/Expected output/.test(evalFixture) && /Pass\/fail bar/.test(evalFixture),
    'agent-eval fixture for icp onboarding has expected-output + pass/fail bar');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
