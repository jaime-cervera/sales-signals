#!/usr/bin/env node

/**
 * account-dedup-safety-tests.mjs — independent proof of the append-only
 * account invariant (the P0 data-integrity core, templates/crm-schema.md).
 *
 * The CRM is ONE ROW PER ACCOUNT (company), append-only. This suite proves,
 * independently of the retired role-based tests, that:
 *   1. A second signal for an existing account folds into ONE row — no
 *      duplicate row; Status only upgrades; Signal/Notes accumulate.
 *   2. P0 INVARIANT: a Won/Opportunity account row is NEVER deleted or
 *      downgraded by a later weaker same-company signal (merge AND dedup).
 *   3. A legacy tracker with two rows for the same company folds into one
 *      account row, preserving the HIGHEST status and both signals (migration).
 *
 * Sandboxing uses CAREER_OPS_TRACKER / CAREER_OPS_ADDITIONS env overrides with
 * mkdtempSync, exactly like tracker-columns-tests.mjs.
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

// Run a script with tracker/additions redirected to a sandbox.
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

function makeSandbox(trackerContent, additions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'co-acct-'));
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

// Data rows of a tracker (pipe lines that aren't header/separator).
function dataRows(trackerPath) {
  return readFileSync(trackerPath, 'utf-8')
    .split('\n')
    .filter(l => l.startsWith('|') && !l.includes('---') && !/\bCompany\b/.test(l));
}

// Find the single account row for a company (asserts there is exactly one).
function accountRows(trackerPath, company) {
  return dataRows(trackerPath).filter(l => l.split('|')[1].trim() === company);
}

const HEADER =
  '# Prospects Tracker\n\n' +
  '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
  '|---------|--------|------------|----------|--------|---------|--------|-------|\n';

// Account TSV order: company\tsignal\tsignaldate\ticpscore\tstatus\tcontact\treport\tnotes

// ── Test 1: second signal folds into ONE row; status only upgrades ─────────
{
  const tracker = HEADER +
    '| Acme | LLMOps Engineer | 2026-01-04 | 4.0/5 | Qualified | jane@acme | — | first signal |\n';
  const sb = makeSandbox(tracker, {
    // Stronger signal (Contacted > Qualified) with a higher score.
    'acme2.tsv': 'Acme\tPlatform Engineer\t2026-02-01\t4.4/5\tContacted\t—\t—\tsecond signal\n',
  });
  const res = runScript('merge-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`merge second signal exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    const rows = accountRows(sb.tracker, 'Acme');
    if (rows.length === 1) pass('second signal does NOT create a duplicate row (one row per account)');
    else fail(`expected 1 Acme row, got ${rows.length}: ${rows.join(' / ')}`);

    const row = rows[0] || '';
    if (/\bContacted\b/.test(row)) pass('status upgraded to the stronger signal (Qualified → Contacted)');
    else fail(`status not upgraded: ${row}`);

    if (row.includes('LLMOps Engineer') && row.includes('Platform Engineer')) {
      pass('Signal history accumulates both signals (no data lost)');
    } else {
      fail(`Signal history did not accumulate: ${row}`);
    }
    if (row.includes('first signal') && row.includes('second signal')) {
      pass('Notes history accumulates both notes (no data lost)');
    } else {
      fail(`Notes history did not accumulate: ${row}`);
    }
    if (row.includes('4.4/5')) pass('ICPScore rose to the higher value');
    else fail(`ICPScore did not rise: ${row}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 2 (P0): a Won account is NEVER deleted or downgraded (merge) ───────
{
  const tracker = HEADER +
    '| Acme | LLMOps Engineer | 2026-01-04 | 4.6/5 | Won | jane@acme | — | closed-won customer |\n';
  const sb = makeSandbox(tracker, {
    // A later WEAKER signal (New, rank 1 << Won rank 7) for the same company.
    'acme-weak.tsv': 'Acme\tJunior Analyst\t2026-03-01\t2.0/5\tNew\t—\t—\tlater weak signal\n',
  });
  const res = runScript('merge-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`merge weaker signal into Won account exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    const rows = accountRows(sb.tracker, 'Acme');
    if (rows.length === 1) pass('P0: Won account row is NOT deleted by a later weaker signal');
    else fail(`P0 VIOLATION: expected 1 Acme row, got ${rows.length}: ${rows.join(' / ')}`);

    const row = rows[0] || '';
    if (/\bWon\b/.test(row) && !/\bNew\b/.test(row.split('|')[5] || '')) {
      pass('P0: Won status is NOT downgraded by a later weaker signal');
    } else {
      fail(`P0 VIOLATION: Won was downgraded: ${row}`);
    }
    // The weaker signal still accumulates into the history (no data loss).
    if (row.includes('Junior Analyst')) pass('weaker signal still recorded in the accumulated history');
    else fail(`weaker signal lost from history: ${row}`);
    // Score must not drop below the Won score.
    if (row.includes('4.6/5')) pass('ICPScore is NOT lowered by the weaker signal');
    else fail(`ICPScore was lowered: ${row}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 2b (P0 via dedup): an Opportunity row survives consolidation ──────
{
  // Two legacy rows for the same company — the FIRST (document order) is the
  // weaker New signal; the SECOND is the strong Opportunity. Consolidation must
  // keep Opportunity, never New.
  const tracker = HEADER +
    '| Acme | Junior Analyst | 2026-03-01 | 2.0/5 | New | — | — | weak first row |\n' +
    '| Acme | LLMOps Engineer | 2026-01-04 | 4.6/5 | Opportunity | jane@acme | — | strong second row |\n';
  const sb = makeSandbox(tracker);
  const res = runScript('dedup-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`dedup with Opportunity row exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    const rows = accountRows(sb.tracker, 'Acme');
    if (rows.length === 1) pass('P0 (dedup): same-company rows fold into ONE account row');
    else fail(`P0 VIOLATION (dedup): expected 1 Acme row, got ${rows.length}`);
    const row = rows[0] || '';
    if (/\bOpportunity\b/.test(row)) pass('P0 (dedup): consolidation keeps the HIGHEST status (Opportunity, never New)');
    else fail(`P0 VIOLATION (dedup): highest status not preserved: ${row}`);
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 3: migration — legacy two-row same-company folds into one ─────────
{
  // The realistic legacy case: two rows for the same company (different roles)
  // accumulated before one-row-per-account consolidation existed.
  const tracker = HEADER +
    '| Globex | Data Engineer | 2026-01-05 | 3.9/5 | Meeting | bob@globex | — | first opening |\n' +
    '| Globex | ML Engineer | 2026-02-10 | 4.2/5 | Contacted | — | — | second opening |\n';
  const sb = makeSandbox(tracker);
  const res = runScript('dedup-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`dedup migration exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    // Both rows normalize to the same company key → one survivor row.
    const rows = dataRows(sb.tracker).filter(l => /globex/i.test(l));
    if (rows.length === 1) pass('migration folds two same-company rows into ONE account row');
    else fail(`expected 1 Globex row after migration, got ${rows.length}: ${rows.join(' / ')}`);
    const row = rows[0] || '';
    // Meeting (rank 5) > Contacted (rank 3) → Meeting must win.
    if (/\bMeeting\b/.test(row)) pass('migration preserves the HIGHEST status (Meeting over Contacted)');
    else fail(`highest status not preserved in migration: ${row}`);
    if (row.includes('Data Engineer') && row.includes('ML Engineer')) {
      pass('migration retains BOTH signals (no data lost)');
    } else {
      fail(`migration lost a signal: ${row}`);
    }
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── Test 4 (P1): 3 same-NEW-company TSVs in ONE merge → one row, no data lost ─
{
  // Three additions for the SAME brand-new company (not yet in the tracker) in a
  // single merge run. Before the fix, only the first was kept and the later two
  // matched the just-created pending row but failed appLines.indexOf() and were
  // SKIPPED, dropping their (possibly higher) status/score/signals/notes.
  const tracker = HEADER;
  const sb = makeSandbox(tracker, {
    'newco1.tsv': 'NewCo\tFirst Signal\t2026-01-10\t2.0/5\tNew\t—\t—\tnote one\n',
    'newco2.tsv': 'NewCo\tSecond Signal\t2026-02-15\t4.5/5\tOpportunity\t—\t—\tnote two\n',
    'newco3.tsv': 'NewCo\tThird Signal\t2026-03-20\t3.0/5\tContacted\t—\t—\tnote three\n',
  });
  const res = runScript('merge-tracker.mjs', [], sb);
  if (res.code !== 0) {
    fail(`merge 3 same-new-company TSVs exits 0 (got ${res.code})\n${res.stdout}`);
  } else {
    const rows = accountRows(sb.tracker, 'NewCo');
    if (rows.length === 1) pass('P1: 3 same-new-company TSVs fold into ONE row (no duplicate rows)');
    else fail(`P1 VIOLATION: expected 1 NewCo row, got ${rows.length}: ${rows.join(' / ')}`);

    const row = rows[0] || '';
    // Opportunity (rank 6) beats Contacted (3) and New (1) — highest rank wins.
    if (/\bOpportunity\b/.test(row)) pass('P1: highest-rank status wins (Opportunity over Contacted/New)');
    else fail(`P1 VIOLATION: highest-rank status not kept: ${row}`);
    // Highest ICPScore must survive (4.5, not 3.0 or 2.0).
    if (row.includes('4.5/5')) pass('P1: highest ICPScore (4.5) is kept');
    else fail(`P1 VIOLATION: highest ICPScore lost: ${row}`);
    // ALL three signals must accumulate (no data lost).
    if (row.includes('First Signal') && row.includes('Second Signal') && row.includes('Third Signal')) {
      pass('P1: all 3 signals accumulate (no data lost)');
    } else {
      fail(`P1 VIOLATION: signal history lost a signal: ${row}`);
    }
    // ALL three notes must accumulate (no data lost).
    if (row.includes('note one') && row.includes('note two') && row.includes('note three')) {
      pass('P1: all 3 notes accumulate (no data lost)');
    } else {
      fail(`P1 VIOLATION: notes history lost a note: ${row}`);
    }
  }
  rmSync(sb.dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
