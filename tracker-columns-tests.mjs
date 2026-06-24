#!/usr/bin/env node

/**
 * tracker-columns-tests.mjs — regression tests for CRM header-name mapping.
 *
 * merge-tracker.mjs and verify-pipeline.mjs map the 8-column CRM tracker
 * (templates/crm-schema.md) by header NAME, never by fixed position:
 *   | Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
 * A reordered header must therefore NOT shift the ICPScore/Status cells. These
 * tests provision a throwaway tracker + additions dir via the
 * CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS env overrides and assert:
 *   1. Merging an account TSV lands every field in the correct CRM column
 *      (ICPScore/Status not shifted).
 *   2. verify-pipeline reports a clean bill of health on a CRM tracker.
 *   3. A REORDERED CRM header (columns in a different order) still maps by name
 *      — ICPScore/Status land correctly, proving name- not position-based parse.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }

// Run a script with tracker/additions redirected to a sandbox. Returns
// { code, stdout } — code is 0 on success, the process exit code otherwise.
function runScript(script, args, sandbox) {
  const env = {
    ...process.env,
    CAREER_OPS_TRACKER: sandbox.tracker,
    CAREER_OPS_ADDITIONS: sandbox.additions,
    CAREER_OPS_TRACKER_LOCK: sandbox.lock,
  };
  try {
    const stdout = execFileSync(NODE, [join(ROOT, script), ...args], {
      cwd: ROOT, env, encoding: 'utf-8', timeout: 30000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// Create a sandbox dir holding a tracker file and an additions dir.
function makeSandbox(trackerContent, additions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'co-cols-'));
  const tracker = join(dir, 'prospects.md');
  const additionsDir = join(dir, 'tracker-additions');
  const lock = join(dir, 'lock');
  mkdirSync(additionsDir, { recursive: true });
  writeFileSync(tracker, trackerContent);
  for (const [name, content] of Object.entries(additions)) {
    writeFileSync(join(additionsDir, name), content);
  }
  return { dir, tracker, additions: additionsDir, lock };
}

// Return the data rows of a tracker (pipe lines that aren't header/separator).
function dataRows(trackerPath) {
  return readFileSync(trackerPath, 'utf-8')
    .split('\n')
    .filter(l => l.startsWith('|') && !l.includes('---') && !/\bCompany\b/.test(l));
}

// Canonical CRM header order.
const HEADER_CRM = `# Prospects Tracker

| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
|---------|--------|------------|----------|--------|---------|--------|-------|
| Acme | LLMOps Engineer | 2026-01-01 | 4.0/5 | Qualified | — | — | seed row |
`;

// A REORDERED CRM header (Status before ICPScore, Contact moved) — header-name
// mapping must still find each column.
const HEADER_REORDERED = `# Prospects Tracker

| Company | Status | Signal | Contact | SignalDate | ICPScore | Report | Notes |
|---------|--------|--------|---------|------------|----------|--------|-------|
| Acme | Qualified | LLMOps Engineer | — | 2026-01-01 | 4.0/5 | — | seed row |
`;

// Account TSV: 8 cols in CRM order (no swap):
// company\tsignal\tsignaldate\ticpscore\tstatus\tcontact\treport\tnotes
const TSV_GLOBEX = 'Globex\tData Engineer\t2026-02-02\t3.8/5\tContacted\tbob@globex\t—\tnew account\n';

// ── Test 1: account TSV merges into the correct CRM columns ────────────────
{
  const sb = makeSandbox(HEADER_CRM, { 'globex.tsv': TSV_GLOBEX });
  const res = runScript('merge-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`merge into CRM tracker exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    pass('merge into CRM tracker exits 0');
    const row = dataRows(sb.tracker).find(l => l.includes('Globex'));
    const cells = row ? row.split('|').map(s => s.trim()) : [];
    // cells: ['', company, signal, signaldate, icpscore, status, contact, report, notes, '']
    if (cells[1] === 'Globex') pass('Company column populated correctly');
    else fail(`Company column — got "${cells[1]}" in row: ${row}`);
    if (cells[2] === 'Data Engineer') pass('Signal column populated correctly');
    else fail(`Signal column — got "${cells[2]}" in row: ${row}`);
    if (cells[4] === '3.8/5') pass('ICPScore sits in the ICPScore column (not shifted)');
    else fail(`ICPScore column — got "${cells[4]}" in row: ${row}`);
    if (cells[5] === 'Contacted') pass('Status sits in the Status column (not shifted)');
    else fail(`Status column — got "${cells[5]}" in row: ${row}`);
    if (cells[6] === 'bob@globex') pass('Contact column populated correctly');
    else fail(`Contact column — got "${cells[6]}" in row: ${row}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 2: verify-pipeline is clean on a CRM tracker ──────────────────────
{
  const sb = makeSandbox(HEADER_CRM);
  const res = runScript('verify-pipeline.mjs', [], sb);
  if (res.code === 0 && /0 errors/.test(res.stdout)) {
    pass('verify-pipeline clean on CRM tracker (no false column errors)');
  } else {
    fail(`verify-pipeline clean on CRM tracker (code ${res.code})\n${res.stdout}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 3: reordered CRM header still maps columns by NAME ────────────────
{
  const sb = makeSandbox(HEADER_REORDERED, { 'globex.tsv': TSV_GLOBEX });
  const merge = runScript('merge-tracker.mjs', [], sb);
  const verify = runScript('verify-pipeline.mjs', [], sb);
  const row = dataRows(sb.tracker).find(l => l.includes('Globex'));
  const cells = row ? row.split('|').map(s => s.trim()) : [];
  // reordered cells: ['', company, status, signal, contact, signaldate, icpscore, report, notes, '']
  if (merge.code === 0 && cells[2] === 'Contacted' && cells[6] === '3.8/5') {
    pass('reordered CRM header merges into correct columns (name-based, not positional)');
  } else {
    fail(`reordered CRM header merge (code ${merge.code}) row: ${row}`);
  }
  if (verify.code === 0 && /0 errors/.test(verify.stdout)) {
    pass('verify-pipeline clean on reordered CRM tracker');
  } else {
    fail(`verify-pipeline clean on reordered CRM tracker (code ${verify.code})\n${verify.stdout}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
