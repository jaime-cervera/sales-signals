#!/usr/bin/env node

/**
 * signals-launcher-tests.mjs — tests for bin/signals.mjs (Unit 1.3).
 *
 * Exercises the launcher END-TO-END via child_process against an isolated ICP
 * tree (CAREER_OPS_ROOT points at a throwaway dir holding icps/{default,acme,
 * globex}). This is the FIRST phase that actually exercises the R7 isolation
 * invariant — operating on one ICP must leave the others byte-identical.
 *
 * Registered in test-all.mjs scripts[].
 */

import { spawnSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(ROOT, 'bin', 'signals.mjs');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

const HEADER =
  '# Prospects Tracker\n\n' +
  '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
  '|---------|--------|------------|----------|--------|---------|--------|-------|\n';

function seedIcp(root, slug, trackerBody) {
  const base = join(root, 'icps', slug);
  mkdirSync(join(base, 'reports'), { recursive: true });
  writeFileSync(join(base, 'signals.yml'), 'title_filter:\n  positive:\n    - "Engineer"\n');
  writeFileSync(join(base, 'prospects.md'), trackerBody);
  writeFileSync(join(base, 'pipeline.md'), '# Pipeline\n\n## Pendientes\n');
}

// Snapshot every file under a dir as {relpath: bytes}.
function snapshot(dir) {
  const out = {};
  const walk = (d, prefix) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, 'utf-8');
    }
  };
  walk(dir, '');
  return out;
}

function runLauncher(args, dataRoot) {
  const res = spawnSync(NODE, [LAUNCHER, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

// ── Build an isolated three-ICP tree ───────────────────────────────────────
const dataRoot = mkdtempSync(join(tmpdir(), 'co-launch-'));
seedIcp(dataRoot, 'default', HEADER); // clean (header only) → verify passes
seedIcp(dataRoot, 'globex', `${HEADER}| Monzo | Data Engineer | 2026-02-03 | 3.8/5 | Contacted | — | — | globex |\n`);
// acme carries a NON-canonical status so `normalize` actually rewrites it.
seedIcp(dataRoot, 'acme', `${HEADER}| Anthropic | LLMOps | 2026-01-15 | 4.2/5 | contactado | — | — | acme |\n`);

// ── No --icp → default ICP ─────────────────────────────────────────────────
{
  const r = runLauncher(['verify', '--icp', 'default'], dataRoot);
  ok(r.code === 0 && /0 errors/.test(r.out), 'verify --icp default runs scoped to icps/default (0 errors)');
}

// ── --icp selects the ICP ──────────────────────────────────────────────────
{
  const r = runLauncher(['verify', '--icp', 'acme'], dataRoot);
  ok(r.code === 0 && /0 errors/.test(r.out), 'verify --icp acme runs scoped to icps/acme');
}

// ── Unknown slug → non-zero, lists ICPs, NO scaffolding ────────────────────
{
  const before = readdirSync(join(dataRoot, 'icps')).sort().join(',');
  const r = runLauncher(['verify', '--icp', 'nonexistent'], dataRoot);
  ok(r.code !== 0, 'unknown --icp exits non-zero');
  ok(/acme/.test(r.out) && /globex/.test(r.out) && /default/.test(r.out),
    'unknown --icp error lists the available ICPs');
  const after = readdirSync(join(dataRoot, 'icps')).sort().join(',');
  ok(before === after && !existsSync(join(dataRoot, 'icps', 'nonexistent')),
    'unknown --icp does NOT scaffold a junk ICP');
}

// ── Isolation invariant: operate on acme, globex stays byte-identical ───────
{
  const globexDir = join(dataRoot, 'icps', 'globex');
  const before = snapshot(globexDir);
  const acmeTrackerBefore = readFileSync(join(dataRoot, 'icps', 'acme', 'prospects.md'), 'utf-8');

  const r = runLauncher(['normalize', '--icp', 'acme'], dataRoot);
  ok(r.code === 0, 'normalize --icp acme runs (exit 0)');

  const acmeTrackerAfter = readFileSync(join(dataRoot, 'icps', 'acme', 'prospects.md'), 'utf-8');
  ok(/Contacted/.test(acmeTrackerAfter) && acmeTrackerAfter !== acmeTrackerBefore,
    'normalize wrote to acme (contactado → Contacted)');

  const after = snapshot(globexDir);
  const sameKeys = JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort());
  const sameBytes = sameKeys && Object.keys(before).every(k => before[k] === after[k]);
  ok(sameBytes, 'ISOLATION: writing to acme left every globex file byte-identical');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
