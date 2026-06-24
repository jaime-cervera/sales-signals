#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for the CRM tracker integrity
 *
 * Checks (against the 8-column CRM schema, templates/crm-schema.md):
 * 1. All statuses are canonical sales states (per states.yml)
 * 2. No duplicate ACCOUNTS (company-only — one row per account)
 * 3. All report links point to existing files
 * 4. ICPScores match format X.X/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. Stale report-number reservation sentinels are garbage-collected
 *
 * Run: node verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const STATES_FILE = existsSync(join(CAREER_OPS, 'templates/states.yml'))
  ? join(CAREER_OPS, 'templates/states.yml')
  : join(CAREER_OPS, 'states.yml');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

// Canonical SALES states + aliases (kept in lockstep with templates/states.yml).
const CANONICAL_STATUSES = [
  'new', 'qualified', 'contacted', 'replied', 'meeting',
  'opportunity', 'won', 'lost', 'disqualified',
];

const ALIASES = {
  'nuevo': 'new', 'detected': 'new', 'signal': 'new',
  'cualificado': 'qualified', 'qualify': 'qualified',
  'contactado': 'contacted', 'outreach': 'contacted', 'reached_out': 'contacted',
  'respondido': 'replied', 'responded': 'replied',
  'reunion': 'meeting', 'meeting_booked': 'meeting', 'demo': 'meeting',
  'oportunidad': 'opportunity', 'deal': 'opportunity', 'opp': 'opportunity',
  'ganado': 'won', 'closed_won': 'won', 'customer': 'won',
  'perdido': 'lost', 'closed_lost': 'lost',
  'descalificado': 'disqualified', 'disqualify': 'disqualified',
  'not_a_fit': 'disqualified', 'no_fit': 'disqualified', 'skip': 'disqualified',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read the CRM tracker ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No tracker found. This is normal for a fresh setup.');
  console.log('   The file will be created when you qualify your first signal.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Map columns by header NAME against the locked 8-column CRM schema
// (templates/crm-schema.md): Company | Signal | SignalDate | ICPScore | Status |
// Contact | Report | Notes. ICPScore maps to the `score` slot so the existing
// score-format check still works; `num`/`role` no longer exist in the CRM.
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
function detectColumns(allLines) {
  for (const line of allLines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('status')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (['company', 'status'].every(k => map[k] != null)) return map;
  }
  return null;
}
const COLMAP = detectColumns(lines);
if (!COLMAP) {
  console.log('\n📊 No CRM header row detected (Company + Status). Nothing to verify.\n');
  process.exit(0);
}
const MAX_IDX = Math.max(...Object.values(COLMAP));

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (line.includes('---')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= MAX_IDX) continue;
  const company = parts[COLMAP.company];
  if (!company || company.toLowerCase() === 'company') continue; // skip header row
  entries.push({
    company,
    signal: COLMAP.signal != null ? parts[COLMAP.signal] : '',
    signaldate: COLMAP.signaldate != null ? parts[COLMAP.signaldate] : '',
    score: COLMAP.score != null ? parts[COLMAP.score] : '',
    status: parts[COLMAP.status],
    contact: COLMAP.contact != null ? parts[COLMAP.contact] : '',
    report: COLMAP.report != null ? parts[COLMAP.report] : '',
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
  });
}

console.log(`\n📊 Checking ${entries.length} account rows in the CRM tracker\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`${e.company}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`${e.company}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`${e.company}: Status contains date: "${e.status}" — dates go in SignalDate`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicate accounts (company-only) ---
// The CRM is one row per account (company). Two rows for the same company is
// the duplicate signal now — there is no role discriminator any more.
const companyMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = e.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!companyMap.has(key)) companyMap.set(key, []);
  companyMap.get(key).push(e);
}
for (const [, group] of companyMap) {
  if (group.length > 1) {
    warn(`Duplicate account rows: ${group[0].company} appears ${group.length}× (one-row-per-account — run dedup-tracker.mjs)`);
    dupes++;
  }
}
if (dupes === 0) ok('No duplicate accounts found');

// --- Check 3: Report links ---
// Markdown links resolve relative to the file that contains them, so report
// links must resolve against the tracker's own directory (see #760). For the
// transition we also accept legacy root-relative links: try the tracker dir
// first, then fall back to the repo root before flagging a link broken.
const TRACKER_DIR = dirname(APPS_FILE);
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const link = match[1];
  if (!existsSync(join(TRACKER_DIR, link)) && !existsSync(join(CAREER_OPS, link))) {
    error(`${e.company}: Report not found: ${link}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: ICPScore format ---
let badScores = 0;
for (const e of entries) {
  const s = (e.score || '').replace(/\*\*/g, '').trim();
  if (!/^\d+\.?\d*\/5$/.test(s) && s !== 'N/A' && s !== 'DUP' && s !== '—' && s !== '') {
    error(`${e.company}: Invalid ICPScore format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All ICPScores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (line.includes('---') || /\bcompany\b/i.test(line.split('|')[1] || '')) continue;
  const parts = line.split('|');
  if (parts.length <= MAX_IDX) {
    error(`Row with too few columns (need ${MAX_IDX} data cols): ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if ((e.score || '').includes('**')) {
    warn(`${e.company}: ICPScore has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in ICPScores');

// --- Check 8: Stale report-number sentinels (GC) ---
// reserve-report-num.mjs drops NNN-RESERVED.md files in reports/ when a
// number is claimed.  If the process crashed before writing the real report
// and deleting the sentinel it will linger.  Sentinels older than 4 h are
// stale; remove them here so they don't skew the next slot allocation.
const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
let staleSentinels = 0;
if (existsSync(REPORTS_DIR)) {
  const now = Date.now();
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > SENTINEL_MAX_AGE_MS) {
        unlinkSync(full);
        warn(`Removed stale reservation sentinel: ${name}`);
        staleSentinels++;
      }
    } catch {
      // Already gone between readdir and stat — fine.
    }
  }
}
if (staleSentinels === 0) ok('No stale reservation sentinels');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
