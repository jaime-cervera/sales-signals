#!/usr/bin/env node
/**
 * migrate-tracker-accounts.mjs — ONE-TIME migration to the account model.
 *
 * Collapses pre-existing same-company multi-row entries in the CRM tracker
 * (CAREER_OPS_TRACKER) into ONE account row each, then rebuilds the SQLite
 * derived index. This is the migration step for trackers that accumulated
 * multiple rows per company before one-row-per-account consolidation existed.
 *
 * Consolidation rules (same as dedup-tracker.mjs, append-only — no data lost):
 *   - Status     = MAX rank across the group (never downgraded, per states.yml)
 *   - ICPScore   = MAX score across the group
 *   - SignalDate = newest date across the group
 *   - Signal/Notes = accumulated history of every folded row
 *   - Contact/Report = first meaningful value (survivor preferred)
 * Identity is the NORMALIZED COMPANY name only.
 *
 * Idempotent: running it again on an already-consolidated tracker is a no-op.
 *
 * Run:
 *   node migrate-tracker-accounts.mjs            # migrate + rebuild index
 *   node migrate-tracker-accounts.mjs --dry-run  # report only, no writes
 *   node migrate-tracker-accounts.mjs --self-test
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

// ── Canonical sales-state ranks (lockstep with templates/states.yml) ──
const STATUS_RANK = {
  'new': 1, 'qualified': 2, 'contacted': 3, 'replied': 4,
  'meeting': 5, 'opportunity': 6, 'won': 7, 'lost': 0, 'disqualified': 0,
  'nuevo': 1, 'detected': 1, 'signal': 1,
  'cualificado': 2, 'qualify': 2,
  'contactado': 3, 'outreach': 3, 'reached_out': 3,
  'respondido': 4, 'responded': 4,
  'reunion': 5, 'meeting_booked': 5, 'demo': 5,
  'oportunidad': 6, 'deal': 6, 'opp': 6,
  'ganado': 7, 'closed_won': 7, 'customer': 7,
  'perdido': 0, 'closed_lost': 0,
  'descalificado': 0, 'disqualify': 0, 'not_a_fit': 0, 'no_fit': 0, 'skip': 0,
};

const HEADER_ALIASES = {
  'company': 'company', 'empresa': 'company',
  'signal': 'signal', 'señal': 'signal', 'senal': 'signal',
  'signaldate': 'signaldate', 'signal date': 'signaldate', 'date': 'signaldate',
  'icpscore': 'score', 'icp score': 'score', 'score': 'score',
  'status': 'status', 'estado': 'status',
  'contact': 'contact', 'contacto': 'contact',
  'report': 'report', 'informe': 'report',
  'notes': 'notes', 'notas': 'notes',
};

/**
 * Normalize a company name into the account grouping key.
 * @param {string} name - Company name from a tracker row.
 * @returns {string} Lowercase company key.
 */
function normalizeCompany(name) {
  return String(name ?? '').toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Rank a status for max-rank consolidation. Unknown → 0.
 * @param {string} status - Raw status value.
 * @returns {number} Sales-pipeline rank.
 */
function statusRank(status) {
  const clean = String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
  return STATUS_RANK[clean] ?? 0;
}

/**
 * Parse a score cell into a numeric value. Missing → 0.
 * @param {string} s - Raw ICPScore cell.
 * @returns {number} Parsed score.
 */
function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Detect CRM columns by header NAME.
 * @param {string[]} allLines - All lines of the tracker.
 * @returns {object|null} header-name → column-index map, or null.
 */
function detectColumns(allLines) {
  for (const line of allLines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('status')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (map.company != null && map.status != null) return map;
  }
  return null;
}

/**
 * Parse one CRM row into an account object by header NAME.
 * @param {string} line - One line from the tracker.
 * @param {object} colmap - header-name → column-index map.
 * @returns {object|null} Parsed account row, or null for non-data rows.
 */
function parseAccountLine(line, colmap) {
  const parts = line.split('|').map(s => s.trim());
  const maxIdx = Math.max(...Object.values(colmap));
  if (parts.length <= maxIdx) return null;
  const company = parts[colmap.company];
  if (!company || company.toLowerCase() === 'company') return null;
  return {
    company,
    signal: colmap.signal != null ? parts[colmap.signal] : '',
    signaldate: colmap.signaldate != null ? parts[colmap.signaldate] : '',
    score: colmap.score != null ? parts[colmap.score] : '',
    status: parts[colmap.status],
    contact: colmap.contact != null ? parts[colmap.contact] : '',
    report: colmap.report != null ? parts[colmap.report] : '',
    notes: colmap.notes != null ? (parts[colmap.notes] || '') : '',
  };
}

/**
 * Append a history value without duplicating it.
 * @param {string} acc - Accumulator.
 * @param {string} next - Incoming value.
 * @param {string} [sep='; '] - Separator.
 * @returns {string} Combined value.
 */
function appendHistory(acc, next, sep = '; ') {
  const a = String(acc ?? '').trim();
  const b = String(next ?? '').trim();
  if (!b || b === '—' || b === '-') return a;
  if (!a || a === '—' || a === '-') return b;
  if (a === b || a.split(sep).includes(b)) return a;
  return `${a}${sep}${b}`;
}

/**
 * Fold a same-company group into one consolidated account object.
 * @param {object[]} group - Same-company rows, document order.
 * @returns {object} Consolidated account.
 */
function foldAccount(group) {
  const merged = { ...group[0] };
  let bestRank = statusRank(merged.status);
  let bestScore = parseScore(merged.score);
  let newestDate = merged.signaldate || '';
  for (let k = 1; k < group.length; k++) {
    const row = group[k];
    if (statusRank(row.status) > bestRank) { bestRank = statusRank(row.status); merged.status = row.status; }
    if (parseScore(row.score) > bestScore) { bestScore = parseScore(row.score); merged.score = row.score; }
    if ((row.signaldate || '') > newestDate) { newestDate = row.signaldate; merged.signaldate = row.signaldate; }
    merged.signal = appendHistory(merged.signal, row.signal);
    merged.notes = appendHistory(merged.notes, row.notes);
    if ((!merged.contact || merged.contact === '—' || merged.contact === '-') && row.contact) merged.contact = row.contact;
    if ((!merged.report || merged.report === '—' || merged.report === '-') && row.report) merged.report = row.report;
  }
  return merged;
}

/**
 * Render a consolidated account object to a CRM table line.
 * @param {object} acc - Account object.
 * @param {object} colmap - header-name → column-index map.
 * @returns {string} Pipe-delimited CRM row.
 */
function buildRow(acc, colmap) {
  const maxIdx = Math.max(...Object.values(colmap));
  const cells = new Array(maxIdx).fill('—');
  const slot = { company: acc.company, signal: acc.signal, signaldate: acc.signaldate,
    score: acc.score, status: acc.status, contact: acc.contact, report: acc.report, notes: acc.notes };
  for (const [key, idx] of Object.entries(colmap)) {
    let v = slot[key];
    if (v === undefined || v === null || v === '') v = (key === 'notes' ? '' : '—');
    cells[idx - 1] = v;
  }
  return '| ' + cells.join(' | ') + ' |';
}

/**
 * Consolidate a tracker's text, collapsing same-company rows.
 *
 * The survivor of each group keeps its physical position; folded rows are
 * removed (their data lives in the survivor). Returns the new text and the
 * number of rows folded.
 *
 * @param {string} content - Raw tracker file content.
 * @returns {{text: string, folded: number, grouped: boolean}}
 */
function consolidate(content) {
  const lines = content.split('\n');
  const colmap = detectColumns(lines);
  if (!colmap) return { text: content, folded: 0, grouped: false };

  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|') || lines[i].includes('---')) continue;
    const acc = parseAccountLine(lines[i], colmap);
    if (acc) { acc.lineIdx = i; entries.push(acc); }
  }

  const groups = new Map();
  for (const e of entries) {
    const key = normalizeCompany(e.company);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  let folded = 0;
  const linesToRemove = new Set();
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const merged = foldAccount(group);
    lines[group[0].lineIdx] = buildRow(merged, colmap);
    for (let k = 1; k < group.length; k++) {
      linesToRemove.add(group[k].lineIdx);
      folded++;
    }
  }

  for (const idx of [...linesToRemove].sort((a, b) => b - a)) lines.splice(idx, 1);
  return { text: lines.join('\n'), folded, grouped: true };
}

/**
 * Resolve the tracker path the same way the other tracker scripts do.
 * @returns {string} The tracker file path.
 */
function resolveTrackerPath() {
  return process.env.CAREER_OPS_TRACKER
    ? process.env.CAREER_OPS_TRACKER
    : existsSync(join(CAREER_OPS, 'data/applications.md'))
      ? join(CAREER_OPS, 'data/applications.md')
      : join(CAREER_OPS, 'applications.md');
}

/**
 * Rebuild the SQLite derived index by invoking `tracker.mjs sync`.
 * Best-effort: an unavailable node:sqlite is logged, not fatal.
 * @param {string} trackerPath - The tracker file path.
 * @returns {void}
 */
function rebuildIndex(trackerPath) {
  try {
    execFileSync(process.execPath, [join(CAREER_OPS, 'tracker.mjs'), 'sync'], {
      cwd: CAREER_OPS,
      env: { ...process.env, CAREER_OPS_TRACKER: trackerPath },
      stdio: 'inherit',
    });
  } catch (e) {
    console.error(`⚠️  Index rebuild skipped: ${e.message}`);
  }
}

/**
 * Run the migration end-to-end against the resolved tracker.
 * @param {boolean} dryRun - When true, report only; no writes.
 * @returns {void}
 */
function runMigration(dryRun) {
  const APPS_FILE = resolveTrackerPath();
  mkdirSync(dirname(APPS_FILE), { recursive: true });

  if (!existsSync(APPS_FILE)) {
    console.log('No tracker found. Nothing to migrate.');
    return;
  }
  const content = readFileSync(APPS_FILE, 'utf-8');
  const { text, folded, grouped } = consolidate(content);
  if (!grouped) {
    console.log('No CRM header row detected (Company + Status). Nothing to migrate.');
    return;
  }

  console.log(`📊 ${folded} duplicate account row(s) would be folded into survivors`);
  if (dryRun) {
    console.log('(dry-run — no changes written, index not rebuilt)');
    return;
  }
  if (folded > 0) {
    copyFileSync(APPS_FILE, APPS_FILE + '.bak');
    writeFileSync(APPS_FILE, text);
    console.log('✅ Tracker consolidated (backup written alongside as .bak)');
  } else {
    console.log('✅ Tracker already one-row-per-account (idempotent no-op)');
  }
  rebuildIndex(APPS_FILE);
}

/**
 * Self-test: prove consolidation folds same-company rows, keeps the highest
 * status, accumulates signals, and is idempotent.
 * @returns {number} Process exit code (0 on success).
 */
function selfTest() {
  let passed = 0, failed = 0;
  const ok = (c, m) => { if (c) { console.log(`PASS ${m}`); passed++; } else { console.error(`FAIL ${m}`); failed++; } };

  const dir = mkdtempSync(join(tmpdir(), 'co-migrate-'));
  try {
    const HEADER =
      '# Prospects Tracker\n\n' +
      '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
      '|---------|--------|------------|----------|--------|---------|--------|-------|\n';
    const input = HEADER +
      '| Acme | Data Engineer | 2026-01-05 | 3.9/5 | Won | jane@acme | — | first |\n' +
      '| Acme | ML Engineer | 2026-02-10 | 4.2/5 | New | — | — | later weak |\n' +
      '| Globex | Analyst | 2026-01-01 | 4.0/5 | Qualified | — | — | only |\n';

    const r1 = consolidate(input);
    ok(r1.folded === 1, 'self-test: one duplicate row folded');
    const acmeRows = r1.text.split('\n').filter(l => l.startsWith('|') && l.split('|')[1].trim() === 'Acme');
    ok(acmeRows.length === 1, 'self-test: Acme collapses to one row');
    ok(/\bWon\b/.test(acmeRows[0]) && !/\bNew\b/.test(acmeRows[0].split('|')[5] || ''),
      'self-test: highest status (Won) preserved, never downgraded');
    ok(acmeRows[0].includes('Data Engineer') && acmeRows[0].includes('ML Engineer'),
      'self-test: both signals retained');
    ok(acmeRows[0].includes('4.2/5'), 'self-test: highest ICPScore kept');

    // Idempotent: re-running on the consolidated output folds nothing.
    const r2 = consolidate(r1.text);
    ok(r2.folded === 0, 'self-test: idempotent (second pass folds nothing)');

    // End-to-end via env-scoped tracker file.
    const tracker = join(dir, 'prospects.md');
    writeFileSync(tracker, input);
    execFileSync(process.execPath, [join(CAREER_OPS, 'migrate-tracker-accounts.mjs')], {
      cwd: CAREER_OPS,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker },
      stdio: 'pipe',
    });
    const after = readFileSync(tracker, 'utf-8');
    const acmeAfter = after.split('\n').filter(l => l.startsWith('|') && l.split('|')[1].trim() === 'Acme');
    ok(acmeAfter.length === 1, 'self-test: end-to-end migration produces one Acme row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// ── Main ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest());
  } else {
    runMigration(process.argv.includes('--dry-run'));
  }
}

export { consolidate, foldAccount, statusRank, normalizeCompany };
