#!/usr/bin/env node

/**
 * path-override-tests.mjs — proves the Unit 1.2 path-parameterization: every
 * data-touching script honors its CAREER_OPS_* env override (operates on the
 * scoped sandbox, NOT a fixed root default). The complementary guarantee —
 * "env unset ⇒ legacy default ⇒ byte-identical behaviour" — is proven by the
 * full test-all.mjs suite staying green with the env unset.
 *
 * Scripts covered: reserve-report-num (CAREER_OPS_REPORTS), normalize-statuses &
 * followup-cadence & analyze-patterns (CAREER_OPS_TRACKER/REPORTS), scan
 * (CAREER_OPS_PORTALS/PIPELINE/SCAN_HISTORY). scan-ats-full shares scan.mjs's
 * writers (covered transitively) + the same getter pattern.
 *
 * Registered in test-all.mjs scripts[].
 */

import { execFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

function run(script, args, env) {
  try {
    const stdout = execFileSync(NODE, [join(ROOT, script), ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 30000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'co-paths-'));
function sb(...p) { return join(sandbox, ...p); }

// ── reserve-report-num.mjs honors CAREER_OPS_REPORTS ───────────────────────
{
  const reportsDir = sb('icp-reports');
  mkdirSync(reportsDir, { recursive: true });
  const res = run('reserve-report-num.mjs', [], { CAREER_OPS_REPORTS: reportsDir });
  const num = res.stdout.trim();
  ok(res.code === 0 && /^\d{3}$/.test(num), `reserve-report-num prints a padded number (got "${num}")`);
  const sentinels = existsSync(reportsDir) ? readdirSync(reportsDir).filter(f => f.endsWith('-RESERVED.md')) : [];
  ok(sentinels.length === 1, 'reserve-report-num writes the RESERVED sentinel into CAREER_OPS_REPORTS, not root/reports');
}

// ── normalize-statuses.mjs --dry-run honors CAREER_OPS_TRACKER ─────────────
{
  const tracker = sb('norm', 'prospects.md');
  mkdirSync(dirname(tracker), { recursive: true });
  writeFileSync(tracker,
    '# Prospects Tracker\n\n' +
    '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
    '|---------|--------|------------|----------|--------|---------|--------|-------|\n' +
    '| Acme | Engineer | 2026-01-01 | 4.0/5 | contactado | — | — | seed |\n');
  const res = run('normalize-statuses.mjs', ['--dry-run'], { CAREER_OPS_TRACKER: tracker });
  ok(res.code === 0 && /Contacted/.test(res.stdout) && /1 statuses normalized/.test(res.stdout),
    'normalize-statuses reads & normalizes the CAREER_OPS_TRACKER sandbox tracker');
}

// ── followup-cadence.mjs honors CAREER_OPS_TRACKER ─────────────────────────
{
  const tracker = sb('fu', 'prospects.md');
  mkdirSync(dirname(tracker), { recursive: true });
  // CRM schema (8 cols, header-name mapped) + a SALES state. Contacted is an
  // actionable stage, so the account shows up in the cadence output.
  writeFileSync(tracker,
    '# Prospects Tracker\n\n' +
    '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
    '|---------|--------|------------|----------|--------|---------|--------|-------|\n' +
    '| Zenith | LLMOps Engineer | 2026-01-01 | 4.0/5 | Contacted | — | — | seed |\n');
  const res = run('followup-cadence.mjs', [], { CAREER_OPS_TRACKER: tracker });
  ok(res.code === 0 && /Zenith/.test(res.stdout),
    'followup-cadence parses the CAREER_OPS_TRACKER sandbox tracker (sees "Zenith")');
}

// ── analyze-patterns.mjs honors CAREER_OPS_TRACKER (+ REPORTS) ─────────────
{
  const tracker = sb('ap', 'prospects.md');
  const reports = sb('ap', 'reports');
  mkdirSync(dirname(tracker), { recursive: true });
  mkdirSync(reports, { recursive: true });
  // CRM schema + a SALES state past Qualified (Lost), so it counts as a "worked"
  // account toward the analysis threshold.
  writeFileSync(tracker,
    '# Prospects Tracker\n\n' +
    '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
    '|---------|--------|------------|----------|--------|---------|--------|-------|\n' +
    '| Nimbus | LLMOps Engineer | 2026-01-01 | 4.0/5 | Lost | — | — | seed |\n');
  const res = run('analyze-patterns.mjs', [], { CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reports });
  // With one worked row, analyze-patterns reports "Not enough data" and exits 1
  // (by design). Its `current` count == the worked accounts it parsed — so
  // `current: 1` proves it read the sandbox tracker (root has no tracker → 0).
  let current = -1;
  try { current = JSON.parse(res.stdout).current ?? -1; } catch {}
  ok(current === 1, `analyze-patterns parses the CAREER_OPS_TRACKER sandbox (current=${current}, expected 1)`);
}

// ── scan.mjs honors CAREER_OPS_PORTALS (+ writes to scoped pipeline/history) ─
{
  const portals = sb('scan', 'portals.yml');
  mkdirSync(dirname(portals), { recursive: true });
  // All companies disabled → no network fetch; proves scan read THIS portals file
  // (the root has no portals.yml, so reading the default would error out).
  writeFileSync(portals,
    'title_filter:\n  positive:\n    - "Engineer"\n' +
    'tracked_companies:\n  - name: DisabledCo\n    careers_url: https://job-boards.greenhouse.io/disabledco\n    enabled: false\n');
  const res = run('scan.mjs', ['--dry-run'], {
    CAREER_OPS_PORTALS: portals,
    CAREER_OPS_PIPELINE: sb('scan', 'pipeline.md'),
    CAREER_OPS_SCAN_HISTORY: sb('scan', 'scan-history.tsv'),
  });
  ok(res.code === 0 && !/portals\.yml.*not found|ENOENT/i.test(res.stdout),
    'scan.mjs loads CAREER_OPS_PORTALS sandbox config (no missing-portals error)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
