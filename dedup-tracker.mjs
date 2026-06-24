#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Account consolidation for the CRM tracker.
 *
 * The CRM is ONE ROW PER ACCOUNT (company), append-only. This script folds any
 * same-company multi-row entries into a single account row:
 *   - Status     = MAX rank across the group (never downgraded — see states.yml)
 *   - ICPScore   = MAX score across the group
 *   - SignalDate = newest date across the group
 *   - Signal     = accumulated signal history of all folded rows (no data lost)
 *   - Notes      = accumulated notes of all folded rows (no data lost)
 *   - Contact / Report = first non-empty value found (survivor preferred)
 * The survivor keeps its physical position; the extra rows are removed ONLY
 * because their data has been folded into the survivor. A row is never deleted
 * with its status/data lost.
 *
 * Identity is the NORMALIZED COMPANY NAME only — role-level fuzzy matching is no
 * longer used for tracker identity (see templates/crm-schema.md). Tracker is the
 * 8-column CRM table; columns are mapped by HEADER NAME, never by position.
 *
 * Run: node dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER lets tests point the script at an isolated fixture so the
// real user tracker is never touched.
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure the target tracker directory exists in both normal and fixture mode.
mkdirSync(dirname(APPS_FILE), { recursive: true });

// Sales-state advancement ranks (kept in lockstep with templates/states.yml).
// Higher = more advanced; the account row keeps the MAX rank ever reached.
const STATUS_RANK = {
  'new': 1,
  'qualified': 2,
  'contacted': 3,
  'replied': 4,
  'meeting': 5,
  'opportunity': 6,
  'won': 7,
  'lost': 0,
  'disqualified': 0,
  // Aliases (states.yml) so legacy/aliased data ranks correctly.
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

/**
 * Normalize a company name into the account grouping key.
 *
 * Presentation differences (punctuation, parenthetical branding, spacing) are
 * removed while keeping the alphanumeric company identity that determines which
 * rows belong to the same account.
 *
 * @param {string} name - Company name from a tracker row.
 * @returns {string} Lowercase company key used for same-company grouping.
 */
function normalizeCompany(name) {
  return String(name ?? '').toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Normalize a status cell before ranking it.
 *
 * Strips bold Markdown and any trailing date, lowercases. Dedup needs the
 * canonical status word only so MAX-rank consolidation works on old and new
 * tracker rows alike.
 *
 * @param {string} status - Raw Status cell.
 * @returns {string} Lowercase status key with Markdown/date noise removed.
 */
function normalizeStatus(status) {
  return String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Convert a status into its sales-pipeline rank.
 *
 * Unknown statuses rank as 0 so malformed data is treated conservatively
 * (never promoted, never used to downgrade a known higher state).
 *
 * @param {string} status - Raw or normalized status value.
 * @returns {number} Numeric rank from STATUS_RANK, or 0 for unknown statuses.
 */
function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] ?? 0;
}

/**
 * Parse a score cell into a numeric value (for MAX-score selection).
 *
 * @param {string} s - Raw ICPScore cell such as `4.3/5` or `**4.3/5**`.
 * @returns {number} Parsed score, or 0 when no number is present.
 */
function parseScore(s) {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Header-name column mapping (CRM schema, see templates/crm-schema.md).
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
 * Detect column indices for the CRM tracker by header NAME.
 *
 * @param {string[]} allLines - All lines of the tracker file.
 * @returns {object|null} header-name → column-index map, or null if not found.
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
 * Parse one CRM table row into an account object by HEADER NAME.
 *
 * Header/separator rows and rows without a real company return null. The raw
 * line and physical index are attached by the caller so removals never depend
 * on globally-unique ids (the CRM has no num column).
 *
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
    raw: line,
  };
}

/**
 * Append a value to an accumulating history field without duplicating it.
 *
 * Used to fold Signal/Notes histories together so no data is lost when two
 * same-company rows are consolidated into one account row.
 *
 * @param {string} acc - The accumulator (survivor's current value).
 * @param {string} next - The value from a folded row.
 * @param {string} [sep='; '] - Separator between history entries.
 * @returns {string} The combined value.
 */
function appendHistory(acc, next, sep = '; ') {
  const a = String(acc ?? '').trim();
  const b = String(next ?? '').trim();
  if (!b || b === '—' || b === '-') return a;
  if (!a || a === '—' || a === '-') return b;
  // Avoid duplicating identical history fragments.
  if (a === b || a.split(sep).includes(b)) return a;
  return `${a}${sep}${b}`;
}

/**
 * Fold a group of same-company rows into one consolidated account row.
 *
 * The survivor is the FIRST row in document order (its physical position is
 * preserved). The consolidated row never downgrades status (MAX rank wins),
 * never lowers ICPScore (MAX wins), advances SignalDate to the newest, and
 * accumulates the full Signal/Notes history of every folded row.
 *
 * @param {object[]} group - Same-company parsed rows, in document order.
 * @returns {{survivor: object, merged: object, foldedCount: number}}
 */
function foldAccount(group) {
  const survivor = group[0];
  const merged = { ...survivor };

  let bestRank = statusRank(merged.status);
  let bestScore = parseScore(merged.score);
  let newestDate = merged.signaldate || '';

  for (let k = 1; k < group.length; k++) {
    const row = group[k];

    // Status: keep the MAX rank ever reached (never downgrade).
    const rank = statusRank(row.status);
    if (rank > bestRank) {
      bestRank = rank;
      merged.status = row.status;
    }

    // ICPScore: keep the highest.
    const score = parseScore(row.score);
    if (score > bestScore) {
      bestScore = score;
      merged.score = row.score;
    }

    // SignalDate: advance to the newest (lexicographic on YYYY-MM-DD).
    if ((row.signaldate || '') > newestDate) {
      newestDate = row.signaldate;
      merged.signaldate = row.signaldate;
    }

    // Signal + Notes: accumulate full history (no data loss).
    merged.signal = appendHistory(merged.signal, row.signal);
    merged.notes = appendHistory(merged.notes, row.notes);

    // Contact / Report: take the first meaningful value if the survivor lacks one.
    if ((!merged.contact || merged.contact === '—' || merged.contact === '-') && row.contact) {
      merged.contact = row.contact;
    }
    if ((!merged.report || merged.report === '—' || merged.report === '-') && row.report) {
      merged.report = row.report;
    }
  }

  return { survivor, merged, foldedCount: group.length - 1 };
}

/**
 * Render a consolidated account row back into a CRM table line, preserving the
 * detected column order.
 *
 * @param {object} acc - Consolidated account object.
 * @param {object} colmap - header-name → column-index map.
 * @returns {string} A pipe-delimited CRM row.
 */
function buildRow(acc, colmap) {
  // Determine the data-column count from the map's max index (cell 0 is the
  // empty pre-pipe artifact; the last data column is maxIdx).
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

// ---- Main ----
if (!existsSync(APPS_FILE)) {
  console.log('No tracker found. Nothing to consolidate.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

const COLMAP = detectColumns(lines);
if (!COLMAP) {
  console.log('No CRM header row detected (Company + Status). Nothing to consolidate.');
  process.exit(0);
}

// Parse all account rows, recording physical line indexes.
const entries = [];
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  if (lines[i].includes('---')) continue;
  const acc = parseAccountLine(lines[i], COLMAP);
  if (acc) {
    acc.lineIdx = i;
    entries.push(acc);
  }
}

console.log(`📊 ${entries.length} account rows loaded`);

// Group by normalized company — company-only identity (no role discriminator).
const groups = new Map();
for (const entry of entries) {
  const key = normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

let folded = 0;
const linesToRemove = new Set();

for (const [, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;

  const { survivor, merged } = foldAccount(companyEntries);

  // Rewrite the survivor row with the consolidated account data.
  lines[survivor.lineIdx] = buildRow(merged, COLMAP);
  console.log(`🧷 Consolidated ${companyEntries.length} rows for "${survivor.company}" → status "${merged.status}", score "${merged.score}"`);

  // Remove the folded duplicate rows (their data now lives in the survivor).
  for (let k = 1; k < companyEntries.length; k++) {
    linesToRemove.add(companyEntries[k].lineIdx);
    folded++;
  }
}

// Remove lines in reverse order to preserve indices.
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${folded} duplicate account row(s) folded into survivors`);

if (!DRY_RUN && folded > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written (backup written alongside as .bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No same-company duplicates found');
}
