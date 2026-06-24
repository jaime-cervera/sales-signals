#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in the CRM tracker.
 *
 * Maps all non-canonical statuses to the canonical SALES states per states.yml:
 *   New, Qualified, Contacted, Replied, Meeting, Opportunity, Won, Lost, Disqualified
 *
 * Also strips markdown bold (**) and trailing dates from the Status field,
 * moving DUPLICADO/legacy info to the Notes column.
 *
 * The tracker is the 8-column CRM table (see templates/crm-schema.md):
 *   | Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
 * Columns are mapped by HEADER NAME (not fixed position) so a reordered or
 * extended layout never shifts the Status cell.
 *
 * Run: node normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER scopes the tracker to the active ICP (set by bin/signals.mjs).
// Unset → the legacy dual-layout defaults, so behaviour is identical when not
// run through the ICP launcher.
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure the tracker's own directory exists (scoped to APPS_FILE, not a fixed
// root data/ — so it is correct under any ICP layout).
mkdirSync(dirname(APPS_FILE), { recursive: true });

// Canonical sales states + aliases (kept in lockstep with templates/states.yml).
const CANONICAL_STATUSES = [
  'New', 'Qualified', 'Contacted', 'Replied', 'Meeting',
  'Opportunity', 'Won', 'Lost', 'Disqualified',
];

const ALIASES = {
  // New
  'new': 'New', 'nuevo': 'New', 'detected': 'New', 'signal': 'New',
  // Qualified
  'qualified': 'Qualified', 'cualificado': 'Qualified', 'qualify': 'Qualified',
  // Contacted
  'contacted': 'Contacted', 'contactado': 'Contacted', 'outreach': 'Contacted', 'reached_out': 'Contacted',
  // Replied
  'replied': 'Replied', 'respondido': 'Replied', 'responded': 'Replied',
  // Meeting
  'meeting': 'Meeting', 'reunion': 'Meeting', 'meeting_booked': 'Meeting', 'demo': 'Meeting',
  // Opportunity
  'opportunity': 'Opportunity', 'oportunidad': 'Opportunity', 'deal': 'Opportunity', 'opp': 'Opportunity',
  // Won
  'won': 'Won', 'ganado': 'Won', 'closed_won': 'Won', 'customer': 'Won',
  // Lost
  'lost': 'Lost', 'perdido': 'Lost', 'closed_lost': 'Lost',
  // Disqualified
  'disqualified': 'Disqualified', 'descalificado': 'Disqualified', 'disqualify': 'Disqualified',
  'not_a_fit': 'Disqualified', 'no_fit': 'Disqualified', 'skip': 'Disqualified',
};

/**
 * Resolve a raw status cell into one canonical sales state.
 *
 * Strips markdown bold and any trailing date, then resolves against the
 * canonical labels / aliases (case-insensitive). DUPLICADO/Repost legacy
 * markers fold into Disqualified and carry their original text into Notes.
 *
 * @param {string} raw - Raw Status cell from the tracker row.
 * @returns {{status: string|null, moveToNotes?: string, unknown?: boolean}}
 */
function normalizeStatus(raw) {
  // Strip markdown bold and trailing dates.
  const s = String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim();
  const lower = s.toLowerCase();

  // DUPLICADO / Repost legacy markers → Disqualified, keep original in notes.
  if (/^duplicado/i.test(s) || /^dup\b/i.test(s) || /^repost/i.test(s)) {
    return { status: 'Disqualified', moveToNotes: String(raw ?? '').trim() };
  }

  // "—" (em dash, no status) → Disqualified.
  if (s === '—' || s === '-' || s === '') return { status: 'Disqualified' };

  // Already canonical — just fix casing/bold.
  for (const c of CANONICAL_STATUSES) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  // Alias → canonical.
  if (ALIASES[lower]) return { status: ALIASES[lower] };

  // Unknown — flag it.
  return { status: null, unknown: true };
}

// Header-name column mapping (CRM schema). The Status cell is no longer at a
// fixed position, so locate it by header NAME (see templates/crm-schema.md).
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
 * Scans for a header row that contains both Company and Status (the minimal
 * CRM identity + state columns). Indexing matches `line.split('|')` (leading
 * empty cell before the first pipe).
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

// Read the tracker.
if (!existsSync(APPS_FILE)) {
  console.log('No tracker found. Nothing to normalize.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

const COLMAP = detectColumns(lines);
if (!COLMAP) {
  console.log('No CRM header row detected (Company + Status). Nothing to normalize.');
  process.exit(0);
}
const MAX_IDX = Math.max(...Object.values(COLMAP));

let changes = 0;
let unknowns = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;
  if (line.includes('---')) continue;

  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= MAX_IDX) continue;

  // Skip the header row itself (its Status cell literally reads "status").
  const company = parts[COLMAP.company];
  if (!company || company.toLowerCase() === 'company') continue;

  const rawStatus = parts[COLMAP.status];
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ company, rawStatus, line: i + 1 });
    continue;
  }

  if (result.status === rawStatus) continue; // Already canonical.

  // Apply change.
  const oldStatus = rawStatus;
  parts[COLMAP.status] = result.status;

  // Move legacy/DUPLICADO info into Notes if needed.
  if (result.moveToNotes && COLMAP.notes != null) {
    const existing = parts[COLMAP.notes] || '';
    if (!existing.includes(result.moveToNotes)) {
      parts[COLMAP.notes] = result.moveToNotes + (existing ? '. ' + existing : '');
    }
  }

  // Strip bold from the ICPScore cell.
  if (COLMAP.score != null && parts[COLMAP.score]) {
    parts[COLMAP.score] = parts[COLMAP.score].replace(/\*\*/g, '');
  }

  // Reconstruct the line (drop the leading/trailing empty split artifacts).
  lines[i] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
  changes++;

  console.log(`${company}: "${oldStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  ${u.company} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  // Backup first.
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written (backup written alongside as .bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No changes needed');
}
