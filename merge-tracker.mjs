#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch account additions into the CRM tracker.
 *
 * The CRM is ONE ROW PER ACCOUNT (company), append-only. An account TSV is 8
 * tab-separated columns matching the CRM header order (no status/score swap):
 *   company\tsignal\tsignaldate\ticpscore\tstatus\tcontact\treport\tnotes
 * Pipe-delimited markdown rows are also accepted.
 *
 * Merge identity: NORMALIZED COMPANY only. A new signal for an existing company
 * folds into that one row — Signal/Notes accumulate, SignalDate advances,
 * ICPScore may rise, and Status keeps the MAX rank ever reached (never
 * downgraded). A new company adds a new row. Validates status against
 * templates/states.yml (rejects non-canonical, logs warning).
 *
 * Run: node merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, rmSync, statSync, realpathSync } from 'fs';
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { normalizeReportLink as normalizeLink } from './tracker-links.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE_RAW = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const APPS_FILE = canonicalizeTrackerPath(APPS_FILE_RAW);
const TRACKER_DIR = dirname(APPS_FILE);
// CAREER_OPS_ADDITIONS overrides the additions dir (used by tests, mirrors CAREER_OPS_TRACKER).
const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS
  ? process.env.CAREER_OPS_ADDITIONS
  : join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const MIGRATE = process.argv.includes('--migrate');
const MERGE_HOLD_MS = Number(process.env.CAREER_OPS_MERGE_HOLD_MS) || 0;
const MERGE_READY_IPC = process.env.CAREER_OPS_MERGE_READY_IPC === '1';

const trackerLockKey = createHash('sha256').update(APPS_FILE).digest('hex').slice(0, 16);
const TRACKER_LOCK_DIR = resolveTrackerLockDir(process.env.CAREER_OPS_TRACKER_LOCK, trackerLockKey);

// The reports/ dir sits at the repo root, which is the tracker's parent in the
// data/ layout (data/applications.md) and the tracker's own dir at root layout.
const REPORTS_ROOT = basename(TRACKER_DIR) === 'data' ? dirname(TRACKER_DIR) : TRACKER_DIR;

/**
 * Normalize report links before writing them into the tracker file.
 *
 * TSV additions use root-relative report links so they are easy for agents to
 * generate. The tracker may live either at `data/applications.md` or at the
 * repository root, so this wrapper binds the correct tracker and reports
 * directories before delegating to the shared link normalizer.
 *
 * @param {string} reportField - Raw report cell from a TSV addition.
 * @returns {string} Markdown report link relative to the tracker file.
 */
const normalizeReportLink = (reportField) => normalizeLink(reportField, TRACKER_DIR, REPORTS_ROOT);

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

/**
 * Convert the tracker path into one stable absolute spelling before hashing it.
 *
 * Equivalent tracker paths can be written in multiple ways, such as a relative
 * path from the current shell, an absolute path, or a path that travels through
 * a symlink. The lock key must be based on one canonical spelling so all merge
 * processes that target the same tracker also target the same lock directory.
 *
 * @param {string} path - Raw tracker path from config, env, or the default.
 * @returns {string} Absolute canonical path when the file exists, else resolved path.
 */
function canonicalizeTrackerPath(path) {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Check whether one absolute path stays inside another directory.
 *
 * This protects recursive lock cleanup from accepting paths that escape the
 * system temp directory through `..` segments or unrelated absolute roots.
 *
 * @param {string} childPath - Candidate path to validate.
 * @param {string} parentDir - Required parent directory boundary.
 * @returns {boolean} True when childPath is inside parentDir or equal to it.
 */
function pathIsInside(childPath, parentDir) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Validate and resolve the tracker lock directory.
 *
 * `CAREER_OPS_TRACKER_LOCK` exists for tests and unusual local layouts, but the
 * merge script later removes the lock directory recursively. To keep that safe,
 * env-provided lock paths must be absolute, live under the OS temp directory,
 * and use the sales-signals lock-name prefix. Invalid values are ignored and the
 * deterministic temp-dir default is used instead.
 *
 * @param {string|undefined} envValue - Optional lock path override.
 * @param {string} lockKey - Stable tracker hash suffix.
 * @returns {string} Safe lock directory path.
 */
function resolveTrackerLockDir(envValue, lockKey) {
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `sales-signals-merge-tracker-${lockKey}.lock`);
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith('sales-signals-merge-tracker-')) return fallback;
  return candidate;
}

/**
 * Pause the async merge flow for a fixed number of milliseconds.
 *
 * This is used in two places:
 * - the lock retry loop, where waiting briefly avoids a tight CPU spin while
 *   another `merge-tracker.mjs` process owns the tracker lock;
 * - the regression test hook (`CAREER_OPS_MERGE_HOLD_MS`), which deliberately
 *   holds the first merge after it reads `applications.md` so a second merge can
 *   try to enter the same critical section.
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine whether a process id still belongs to a live process.
 *
 * The tracker lock stores the owner PID in `owner.json`. When another process
 * finds an existing lock, this check lets it distinguish a valid live owner from
 * a crashed process that left a stale lock directory behind. `EPERM` counts as
 * alive because the process exists even if the current user cannot signal it.
 *
 * @param {number} pid - Process id recorded by the lock owner.
 * @returns {boolean} True when the process appears to still exist.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Read lock ownership metadata from a tracker lock directory.
 *
 * The metadata contains the owner PID, a unique release token, the acquisition
 * timestamp, and the tracker path. Invalid or missing metadata is treated as
 * unreadable so the stale-lock recovery path can fall back to directory age.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @returns {object|null} Parsed owner metadata, or null when unavailable.
 */
function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock can be safely recovered.
 *
 * Recovery is conservative: if the lock has an owner PID and that process is
 * still alive, the lock is never considered stale merely because it is old. If
 * the owner process is gone, or if the metadata cannot be read and the lock
 * directory itself is older than the stale threshold, the waiting process may
 * remove the lock and retry acquisition.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @param {number} staleMs - Age threshold for metadata-free lock recovery.
 * @returns {boolean} True when the caller may remove and recreate the lock.
 */
function lockCanRecover(lockDir, staleMs) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);

  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Acquire an exclusive filesystem lock for one tracker merge.
 *
 * The critical section must cover the full read/modify/write/move sequence, not
 * just the final write. Otherwise two processes can read the same old tracker
 * snapshot, compute independent updates, and let the later writer erase rows
 * written by the earlier one. The lock is implemented with atomic directory
 * creation, owner metadata, retry/backoff, stale-owner recovery, and a release
 * token so one process cannot delete another process's newer lock.
 *
 * @param {string} lockDir - Directory path used as the lock sentinel.
 * @param {object} [options] - Lock timing options.
 * @param {number} [options.timeoutMs=60000] - Maximum time to wait for the lock.
 * @param {number} [options.retryMs=75] - Delay between acquisition attempts.
 * @param {number} [options.staleMs=600000] - Metadata-free stale-lock threshold.
 * @returns {Promise<{attempts:number,waitMs:number,staleRecovered:boolean,release:Function}>}
 * Lock handle with metadata and an idempotent release method.
 */
async function acquireTrackerLock(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const startedAt = Date.now();
  let attempts = 0;
  let staleRecovered = false;

  while (Date.now() - startedAt < timeoutMs) {
    attempts++;
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        tracker: APPS_FILE,
      }, null, 2));

      let released = false;
      return {
        attempts,
        waitMs: Date.now() - startedAt,
        staleRecovered,
        release() {
          if (released) return;
          released = true;
          const owner = readLockOwner(lockDir);
          if (owner?.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (guardErr?.code !== 'EEXIST') throw guardErr;
      }

      if (hasRecoverGuard) {
        try {
          if (lockCanRecover(lockDir, staleMs)) {
            rmSync(lockDir, { recursive: true, force: true });
            staleRecovered = true;
            continue;
          }
        } finally {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      await sleep(retryMs);
    }
  }

  throw new Error(`Timed out waiting for tracker merge lock at ${lockDir}`);
}

/**
 * Replace a tracker file atomically using a same-directory temporary file.
 *
 * Writing into the same directory keeps the final `renameSync` atomic on normal
 * filesystems and avoids exposing a partially written `applications.md` to other
 * readers. If the write or rename fails, the temporary file is cleaned up before
 * the original error is rethrown.
 *
 * @param {string} path - Final file path to replace.
 * @param {string} content - Complete file content to write.
 * @returns {void}
 */
function writeFileAtomic(path, content) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

let trackerLock;
try {
  trackerLock = await acquireTrackerLock(TRACKER_LOCK_DIR, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
  });
  process.once('exit', () => trackerLock?.release());
  if (trackerLock.waitMs > 0 || trackerLock.staleRecovered) {
    console.log(`🔒 Tracker merge lock acquired (wait_ms=${trackerLock.waitMs} | attempts=${trackerLock.attempts} | stale_recovered=${trackerLock.staleRecovered})`);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

// Canonical SALES states + aliases (kept in lockstep with templates/states.yml).
const CANONICAL_STATES = ['New', 'Qualified', 'Contacted', 'Replied', 'Meeting', 'Opportunity', 'Won', 'Lost', 'Disqualified'];

// Sales-state advancement ranks (max-rank wins on an account merge — never
// downgrade). Kept in lockstep with templates/states.yml.
const STATUS_RANK = {
  'new': 1, 'qualified': 2, 'contacted': 3, 'replied': 4,
  'meeting': 5, 'opportunity': 6, 'won': 7, 'lost': 0, 'disqualified': 0,
};

/**
 * Convert raw addition status text into one canonical sales state.
 *
 * Batch workers and older tracker additions may emit Spanish labels, bold
 * Markdown, legacy date suffixes, or signal markers. The merge script normalizes
 * all of those variants here so the tracker keeps the states defined by
 * templates/states.yml.
 *
 * @param {string} status - Raw status string from a TSV or pipe-delimited row.
 * @returns {string} Canonical tracker status.
 */
function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases (states.yml)
  const aliases = {
    'nuevo': 'New', 'detected': 'New', 'signal': 'New',
    'cualificado': 'Qualified', 'qualify': 'Qualified',
    'contactado': 'Contacted', 'outreach': 'Contacted', 'reached_out': 'Contacted',
    'respondido': 'Replied', 'responded': 'Replied',
    'reunion': 'Meeting', 'meeting_booked': 'Meeting', 'demo': 'Meeting',
    'oportunidad': 'Opportunity', 'deal': 'Opportunity', 'opp': 'Opportunity',
    'ganado': 'Won', 'closed_won': 'Won', 'customer': 'Won',
    'perdido': 'Lost', 'closed_lost': 'Lost',
    'descalificado': 'Disqualified', 'disqualify': 'Disqualified',
    'not_a_fit': 'Disqualified', 'no_fit': 'Disqualified', 'skip': 'Disqualified',
  };

  if (aliases[lower]) return aliases[lower];

  // DUPLICADO/Repost legacy markers → Disqualified
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Disqualified';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "New"`);
  return 'New';
}

/**
 * Rank a status for max-rank account merging (never downgrade).
 *
 * @param {string} status - Raw or canonical status value.
 * @returns {number} Numeric rank from STATUS_RANK, or 0 for unknown statuses.
 */
function statusRank(status) {
  const clean = String(status ?? '').replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim().toLowerCase();
  return STATUS_RANK[clean] ?? 0;
}

/**
 * Normalize company names for duplicate lookup during tracker merges.
 *
 * Company names can contain spaces, punctuation, or branding variants in the
 * tracker and incoming TSV rows. This is the SHARED account-identity key used by
 * merge-tracker, dedup-tracker, and migrate-tracker-accounts, so the one-row-per
 * -account boundary is uniform: a merge and a later dedup group the same rows.
 * Lowercase, drop parenthetical branding, collapse spaces, strip remaining
 * non-alphanumerics (keeping word boundaries as spaces), trim.
 *
 * @param {string} name - Company name from the tracker or addition row.
 * @returns {string} Lowercase company identity key.
 */
function normalizeCompany(name) {
  return String(name ?? '').toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Append a value to an accumulating history field without duplicating it.
 *
 * Used to fold the Signal/Notes histories of a new signal into the existing
 * account row so no data is lost across the append-only account merge.
 *
 * @param {string} acc - The accumulator (existing row's current value).
 * @param {string} next - The value from the incoming signal.
 * @param {string} [sep='; '] - Separator between history entries.
 * @returns {string} The combined value.
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
 * Parse a score cell into a numeric value for score-upgrade decisions.
 *
 * The merge path compares old and new scores to decide whether to update an
 * existing duplicate row. Markdown bolding and `/5` suffixes are presentation
 * details, so only the first numeric value is used.
 *
 * @param {string} s - Raw score cell such as `4.2/5`.
 * @returns {number} Parsed score, or 0 when no numeric value is present.
 */
function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Column layout for the CRM tracker (templates/crm-schema.md):
//   Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes
// Columns are mapped by header NAME, never by fixed position. ICPScore maps to
// the `score` slot for alias compatibility. COLMAP is set once a header row is
// detected; merging requires a CRM header (no positional fallback).
let COLMAP = null;

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

// Scan the table for a header row and build a header-name → column-index map.
// Indexing matches `line.split('|')` (leading empty cell before the first pipe),
// the same split parseAppLine uses. Returns null unless the essential CRM
// columns (Company + Status) are present, so a stray pipe line can't yield a
// bogus mapping.
function detectColumns(lines) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('status')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (['company', 'status'].every(k => map[k] != null)) return map;
  }
  return null;
}

// Build a CRM tracker row string matching the detected column order so writes
// round-trip through the same schema. The CRM is the locked 8-column layout.
function buildRow(o) {
  const maxIdx = Math.max(...Object.values(COLMAP));
  const cells = new Array(maxIdx).fill('—');
  const slot = {
    company: o.company, signal: o.signal, signaldate: o.signaldate,
    score: o.score, status: o.status, contact: o.contact, report: o.report, notes: o.notes,
  };
  for (const [key, idx] of Object.entries(COLMAP)) {
    let v = slot[key];
    if (v === undefined || v === null || v === '') v = (key === 'notes' ? '' : '—');
    cells[idx - 1] = v;
  }
  return '| ' + cells.join(' | ') + ' |';
}

/**
 * Parse one CRM table row into an account object by HEADER NAME.
 *
 * Header/separator rows and rows without a real company return null. Valid rows
 * preserve the original raw line so the merge logic can locate and replace the
 * exact tracker line when a new same-company signal arrives.
 *
 * @param {string} line - One line from the tracker.
 * @returns {object|null} Parsed account row, or null for non-data rows.
 */
function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  const maxIdx = Math.max(...Object.values(COLMAP));
  if (parts.length <= maxIdx) return null;
  const company = parts[COLMAP.company];
  if (!company || company.toLowerCase() === 'company') return null;
  return {
    company,
    signal: COLMAP.signal != null ? parts[COLMAP.signal] : '',
    signaldate: COLMAP.signaldate != null ? parts[COLMAP.signaldate] : '',
    score: COLMAP.score != null ? parts[COLMAP.score] : '',
    status: parts[COLMAP.status],
    contact: COLMAP.contact != null ? parts[COLMAP.contact] : '',
    report: COLMAP.report != null ? parts[COLMAP.report] : '',
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
    raw: line,
  };
}

/**
 * Parse a TSV file content into a structured account-addition object.
 *
 * The account TSV is 8 tab-separated columns matching the CRM header order
 * (no status/score swap): company, signal, signaldate, icpscore, status,
 * contact, report, notes. Pipe-delimited Markdown rows (the CRM row literal)
 * are also accepted. Additions without a usable company are rejected so
 * malformed batch output cannot corrupt the tracker.
 *
 * @param {string} content - Raw file content from batch/tracker-additions.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {object|null} Parsed account addition, or null when malformed.
 */
function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row).
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim());
    // Drop the leading/trailing empty cells produced by the surrounding pipes.
    if (parts[0] === '') parts = parts.slice(1);
    if (parts[parts.length - 1] === '') parts = parts.slice(0, -1);
    if (parts.length < 5) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
  } else {
    // Tab-separated.
    parts = content.split('\t').map(s => s.trim());
    if (parts.length < 5) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }
  }

  // CRM column order: company | signal | signaldate | icpscore | status | contact | report | notes
  addition = {
    company: parts[0],
    signal: parts[1] || '—',
    signaldate: parts[2] || '—',
    score: parts[3] || '—',
    status: validateStatus(parts[4]),
    contact: parts[5] || '—',
    report: parts[6] || '—',
    notes: parts[7] || '',
  };

  if (!addition.company || addition.company === '—') {
    console.warn(`⚠️  Skipping ${filename}: missing company`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Read the CRM tracker
if (!existsSync(APPS_FILE)) {
  console.log('No tracker found. Nothing to merge into.');
  process.exit(0);
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
// Test-only synchronization hook: the concurrent merge test waits for the
// first worker to read the tracker while still holding the lock, then starts a
// second worker to prove the lock prevents the old lost-update race.
if (MERGE_READY_IPC && typeof process.send === 'function') {
  process.send({ type: 'merge-tracker-ready' });
}
if (MERGE_HOLD_MS > 0) {
  await sleep(MERGE_HOLD_MS);
}

// One-time migration: rewrite existing report links so they resolve relative
// to the tracker file's directory (see #760). Run with: node merge-tracker.mjs --migrate
if (MIGRATE) {
  const migrated = appContent
    .split('\n')
    .map(line => (line.startsWith('|') ? normalizeReportLink(line) : line));
  const before = appContent.split('\n');
  const changed = migrated.filter((l, i) => l !== before[i]).length;

  if (DRY_RUN) {
    console.log(`🔎 Migration (dry-run): ${changed} row(s) would be rewritten in ${basename(APPS_FILE)}`);
  } else {
    writeFileAtomic(APPS_FILE, migrated.join('\n'));
    console.log(`✅ Migration: rewrote ${changed} report link(s) in ${basename(APPS_FILE)} relative to ${TRACKER_DIR === CAREER_OPS ? 'repo root' : 'data/'}`);
  }
  process.exit(0);
}

const appLines = appContent.split('\n');
// Detect the tracker's CRM column layout via header NAMES so parsing and writing
// both work regardless of column order. Merging needs a CRM header row.
COLMAP = detectColumns(appLines);
if (!COLMAP) {
  console.log('No CRM header row detected (Company + Status). Nothing to merge into.');
  process.exit(0);
}
const existingApps = [];

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---')) {
    const app = parseAppLine(line);
    if (app) existingApps.push(app);
  }
}

console.log(`📊 Existing: ${existingApps.length} account rows`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Normalize the report link to be relative to the tracker file's directory.
  // The TSV convention carries a root-relative `reports/...` link; rewrite it
  // so it resolves correctly when clicked from the tracker (see #760).
  if (addition.report && addition.report !== '—') {
    addition.report = normalizeReportLink(addition.report);
  }

  // ACCOUNT identity is the NORMALIZED COMPANY only (one row per account). A new
  // signal for an existing company folds into that one row, append-only — it
  // never adds a second row and never downgrades the row's status.
  const normCompany = normalizeCompany(addition.company);
  const existing = existingApps.find(app => normalizeCompany(app.company) === normCompany);

  if (existing) {
    // Fold the new signal into the existing account row (append-only).
    // The target row is either an already-committed tracker line (found in
    // appLines) OR a pending new-company row created earlier in THIS run (held
    // in newLines, not yet in appLines — its newLineIdx points into newLines).
    const lineIdx = appLines.indexOf(existing.raw);
    const pendingIdx = existing.newLineIdx;
    if (lineIdx < 0 && pendingIdx == null) { skipped++; continue; }

    // Status: keep the MAX rank ever reached (never downgrade).
    const keepStatus = statusRank(addition.status) > statusRank(existing.status)
      ? addition.status : existing.status;
    // ICPScore: keep the highest.
    const keepScore = parseScore(addition.score) > parseScore(existing.score)
      ? addition.score : existing.score;
    // SignalDate: advance to the newest.
    const keepDate = (addition.signaldate || '') > (existing.signaldate || '')
      ? addition.signaldate : existing.signaldate;
    // Signal + Notes: accumulate the full history (no data loss).
    const mergedSignal = appendHistory(existing.signal, addition.signal);
    const mergedNotes = appendHistory(existing.notes, addition.notes);

    const updatedLine = buildRow({
      company: existing.company,
      signal: mergedSignal,
      signaldate: keepDate,
      score: keepScore,
      status: keepStatus,
      contact: (existing.contact && existing.contact !== '—') ? existing.contact : addition.contact,
      report: (existing.report && existing.report !== '—') ? existing.report : addition.report,
      notes: mergedNotes,
    });
    // Rewrite the row in place: a committed appLines row, or the pending
    // newLines row when this same-company account was first seen this run.
    if (lineIdx >= 0) {
      appLines[lineIdx] = updatedLine;
    } else {
      newLines[pendingIdx] = updatedLine;
    }
    // Keep the in-memory snapshot consistent for subsequent additions in this run.
    existing.raw = updatedLine;
    existing.signal = mergedSignal;
    existing.signaldate = keepDate;
    existing.score = keepScore;
    existing.status = keepStatus;
    existing.notes = mergedNotes;
    // A folded-in signal for a brand-new company is an update of a row this run
    // will add, not a separate add — count it as updated, not added.
    updated++;
    console.log(`🔄 Fold signal into ${existing.company} → status "${keepStatus}", score "${keepScore}"`);
  } else {
    // New account — add a new row.
    const newLine = buildRow({
      company: addition.company,
      signal: addition.signal,
      signaldate: addition.signaldate,
      score: addition.score,
      status: addition.status,
      contact: addition.contact,
      report: addition.report,
      notes: addition.notes,
    });
    const newLineIdx = newLines.push(newLine) - 1;
    // Track it so later additions in this run fold into it rather than skip or
    // duplicate. newLineIdx lets the fold path rewrite this pending row in place
    // (it is not yet in appLines, so appLines.indexOf can't locate it).
    const parsed = parseAppLine(newLine);
    if (parsed) {
      parsed.newLineIdx = newLineIdx;
      existingApps.push(parsed);
    }
    added++;
    console.log(`➕ Add account ${addition.company} (${addition.status}, ${addition.score})`);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx >= 0) {
    appLines.splice(insertIdx, 0, ...newLines);
  }
}

// Write back
if (!DRY_RUN) {
  writeFileAtomic(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
trackerLock.release();

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
