#!/usr/bin/env node

/**
 * tracker.mjs — SQLite derived index for the applications tracker (RFC #918, phase 1).
 *
 * data/applications.md stays the source of truth. The SQLite DB is a derived
 * index, built and rebuilt from the markdown — safe to delete at any time, it
 * regenerates on the next sync. Tools and agents READ through the index for
 * schema-validated, model-independent results; all writes keep going to the
 * markdown exactly as today (merge-tracker.mjs, hand edits).
 *
 * Why: at hundreds of rows, a markdown table degrades structurally — encoding
 * corruption propagates, columns drift, a `|` inside a cell shifts every
 * column after it, and agents grepping the table get model-dependent results.
 * The index normalizes on sync (canonical statuses, repaired columns) so every
 * query returns the same rows for every model on every CLI, and corruption is
 * DETECTED at sync time instead of propagating silently.
 *
 * Phase 2 of #918 (DB becomes source of truth, markdown becomes a rendered
 * view) is a separate, explicit per-user opt-in — not implemented here.
 *
 * Zero new dependencies — uses node:sqlite (built into Node >= 22.5).
 *
 * Usage:
 *   node tracker.mjs sync [--check]             # (re)build the .db index from the CRM tracker markdown
 *                                               # --check: diagnose only, no write; exit 1 if issues found
 *   node tracker.mjs query [--status Qualified] [--company acme] [--signal engineer]
 *                          [--since 2026-01-01] [--id N] [--limit 20] [--json]
 *   node tracker.mjs history --id N             # status transition log observed across syncs
 *   node tracker.mjs export [--out FILE]        # inverse: index → canonical CRM markdown (stdout by default)
 *
 * query/history auto-resync when the tracker markdown changed since the last
 * sync, so the index can never serve stale reads.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

const MD_PATH = process.env.CAREER_OPS_TRACKER || 'data/applications.md';
const DB_PATH = process.env.CAREER_OPS_TRACKER_DB
  || (MD_PATH.endsWith('.md') ? MD_PATH.slice(0, -3) + '.db' : MD_PATH + '.db');

// SQLite must never open the source of truth itself (an explicit
// CAREER_OPS_TRACKER_DB could point both names at the same file).
if (resolve(MD_PATH) === resolve(DB_PATH)) {
  console.error(`Error: DB path must differ from the markdown path (${MD_PATH}).`);
  process.exit(1);
}
const STATES_PATH = 'templates/states.yml';
// CRM schema (templates/crm-schema.md) — 8 columns, one row per account.
const HEADER = '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |';
const SEPARATOR = '|---------|--------|------------|----------|--------|---------|--------|-------|';

// ── node:sqlite loading ─────────────────────────────────────────────

async function loadSqlite() {
  // node:sqlite is stable in behavior but still flagged experimental in some
  // Node lines — silence only that one warning, leave everything else alone.
  const origEmit = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === 'string' ? warning : warning?.message || '';
    if (text.includes('SQLite is an experimental feature')) return;
    return origEmit.call(process, warning, ...args);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } catch {
    console.error('Error: node:sqlite is not available. tracker.mjs needs Node >= 22.5 (you are on ' + process.version + ').');
    console.error('The markdown tracker keeps working without it — the index is optional.');
    process.exit(1);
  } finally {
    process.emitWarning = origEmit; // the warning fires at import time — safe to restore here
  }
}

function openDb(DatabaseSync) {
  mkdirSync(dirname(DB_PATH) || '.', { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON'); // SQLite ignores REFERENCES without this
  // The derived index mirrors the CRM schema (templates/crm-schema.md):
  // one row per account. `pos` keeps the document order so export round-trips
  // losslessly. `id` is a stable per-account key for status_events history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id          INTEGER PRIMARY KEY,
      pos         INTEGER NOT NULL,
      company     TEXT NOT NULL,
      signal      TEXT NOT NULL DEFAULT '—',
      signal_date TEXT NOT NULL DEFAULT '—',
      icp_score   TEXT NOT NULL DEFAULT '—',
      status      TEXT NOT NULL,
      contact     TEXT NOT NULL DEFAULT '—',
      report      TEXT NOT NULL DEFAULT '—',
      notes       TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS status_events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES applications(id),
      status TEXT NOT NULL,
      date   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company);
    CREATE INDEX IF NOT EXISTS idx_events_app ON status_events(app_id);
  `);
  return db;
}

// ── Canonical states (templates/states.yml is the source of truth) ──

function loadStates() {
  if (!existsSync(STATES_PATH)) {
    console.error(`Error: ${STATES_PATH} not found — cannot validate statuses. Run from the Sales-Signals root.`);
    process.exit(1);
  }
  const doc = yaml.load(readFileSync(STATES_PATH, 'utf-8'));
  const byKey = new Map(); // lowercased label/alias → canonical label
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    byKey.set(s.label.toLowerCase(), s.label);
    if (s.id) byKey.set(String(s.id).toLowerCase(), s.label);
    for (const alias of s.aliases || []) byKey.set(String(alias).toLowerCase(), s.label);
  }
  return { byKey, labels };
}

// Strip markdown bold, trailing dates, and surrounding noise, then resolve
// against canonical labels/aliases. Returns the canonical label or null.
function normalizeStatus(raw, states) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.byKey.get(cleaned) || null;
}

const SCORE_RE = /^\*{0,2}(\d(?:\.\d)?\/5)\*{0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mojibake left by a UTF-8 → GBK → UTF-8 round trip: an em-dash cell becomes
// "鈥?" / "鈥�" variants. Only short placeholder cells are repaired — free-text
// notes are preserved as-is rather than risk corrupting real content.
function repairPlaceholder(cell) {
  if (/^鈥.{0,2}$/.test(cell) || cell === '�') return '—';
  return cell;
}

// ── Markdown parsing ────────────────────────────────────────────────

// CRM header-name → field alias map (templates/crm-schema.md). The CRM has no
// num column and the id is assigned by the index, so columns are located by
// header NAME, never by fixed position.
const HEADER_ALIASES = {
  'company': 'company', 'empresa': 'company',
  'signal': 'signal', 'señal': 'signal', 'senal': 'signal',
  'signaldate': 'signal_date', 'signal date': 'signal_date', 'date': 'signal_date',
  'icpscore': 'icp_score', 'icp score': 'icp_score', 'score': 'icp_score',
  'status': 'status', 'estado': 'status',
  'contact': 'contact', 'contacto': 'contact',
  'report': 'report', 'informe': 'report',
  'notes': 'notes', 'notas': 'notes',
};
const CRM_FIELDS = ['company', 'signal', 'signal_date', 'icp_score', 'status', 'contact', 'report', 'notes'];

// Find the CRM header row and return a field → 0-based cell-index map (relative
// to cells AFTER the surrounding pipes are stripped). Returns null when no
// recognizable CRM header (Company + Status) is present.
function detectColumns(text) {
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('status')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (map.company != null && map.status != null) return map;
  }
  return null;
}

function parseMarkdownRows(text, colmap, diag) {
  const rows = [];
  const maxIdx = Math.max(...Object.values(colmap));
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    let cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    if (/^[-: ]*$/.test(cells.join(''))) continue; // separator row
    // Skip the header row itself (its Company cell literally reads "company").
    if ((cells[colmap.company] || '').toLowerCase() === 'company') continue;
    if (cells.length > maxIdx + 1) {
      // Stray pipes — fold the overflow into the last (notes) column.
      const head = cells.slice(0, maxIdx);
      cells = [...head, cells.slice(maxIdx).join(' | ')];
      if (diag) diag.strayPipes++;
    }
    while (cells.length <= maxIdx) cells.push('');
    rows.push(cells);
  }
  return rows;
}

// Parse + normalize the markdown into index-ready rows. The markdown itself is
// never modified — normalization lives only in the derived index, and the
// diagnostics tell the user what to fix at the source (normalize-statuses.mjs,
// dedup-tracker.mjs).
function parseTracker(states) {
  const diag = { mojibake: 0, scoreInStatus: 0, unknownStatus: 0, badId: 0, badDate: 0, strayPipes: 0 };
  const text = readFileSync(MD_PATH, 'utf-8');
  const colmap = detectColumns(text);
  if (!colmap) return { apps: [], diag };
  const rows = parseMarkdownRows(text, colmap, diag);

  const apps = [];
  let id = 0;

  for (const cells of rows) {
    const get = (field) => (colmap[field] != null ? (cells[colmap[field]] ?? '') : '');
    const company = get('company');
    if (!company) continue;
    let signal = get('signal');
    let signalDate = get('signal_date');
    let score = get('icp_score');
    let status = get('status');
    const contact = get('contact');
    let report = get('report');
    let notes = get('notes');

    const before = [score, contact, report].join('|');
    score = repairPlaceholder(score);
    report = repairPlaceholder(report);
    if ([score, contact, report].join('|') !== before) diag.mojibake++;

    // Score sitting in the status column (column drift).
    const scoreInStatus = status.match(SCORE_RE);
    if (scoreInStatus) {
      if (!SCORE_RE.test(score)) score = scoreInStatus[1];
      status = 'New';
      diag.scoreInStatus++;
    }

    const canonical = normalizeStatus(status, states);
    if (!canonical) {
      notes = notes ? `${notes} [sync: original status "${status}"]` : `[sync: original status "${status}"]`;
      status = 'New';
      diag.unknownStatus++;
    } else {
      status = canonical;
    }

    if (signalDate && signalDate !== '—' && !DATE_RE.test(signalDate)) diag.badDate++; // flagged, not destroyed

    apps.push({
      id: ++id,
      pos: apps.length,
      company,
      signal: signal || '—',
      signal_date: signalDate || '—',
      icp_score: score || '—',
      status,
      contact: contact || '—',
      report: report || '—',
      notes,
    });
  }

  return { apps, diag };
}

function mdHash() {
  return createHash('sha256').update(readFileSync(MD_PATH)).digest('hex');
}

// ── Sync (markdown → derived index) ─────────────────────────────────

function reportDiagnostics(diag) {
  const total = Object.values(diag).reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.error('No corruption detected — index matches the markdown cleanly.');
    return 0;
  }
  console.error(`Corruption detected in ${MD_PATH} (normalized in the index only — the markdown is untouched):`);
  if (diag.mojibake) console.error(`  ${diag.mojibake} mojibake placeholder cell(s)`);
  if (diag.scoreInStatus) console.error(`  ${diag.scoreInStatus} ICPScore(s) sitting in the status column`);
  if (diag.unknownStatus) console.error(`  ${diag.unknownStatus} non-canonical status(es), indexed as New (original kept in notes)`);
  if (diag.badDate) console.error(`  ${diag.badDate} malformed SignalDate(s), kept as-is`);
  if (diag.strayPipes) console.error(`  ${diag.strayPipes} row(s) with stray pipes, folded into notes`);
  console.error('Fix at the source with `node normalize-statuses.mjs` / `node dedup-tracker.mjs`, then re-sync.');
  return total;
}

function syncIndex(db, states) {
  const { apps, diag } = parseTracker(states);
  const today = new Date().toISOString().slice(0, 10);

  db.exec('BEGIN');
  db.exec('PRAGMA defer_foreign_keys = ON'); // full rebuild — FKs settle at commit
  try {
    db.exec('DELETE FROM applications');
    const insertApp = db.prepare('INSERT INTO applications (id, pos, company, signal, signal_date, icp_score, status, contact, report, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const a of apps) insertApp.run(a.id, a.pos, a.company, a.signal, a.signal_date, a.icp_score, a.status, a.contact, a.report, a.notes);

    // Status history: events persist across rebuilds, keyed by id. An app whose
    // status changed since the last sync gets a new event; rows that left the
    // markdown lose their events (the index never outlives its source).
    db.exec('DELETE FROM status_events WHERE app_id NOT IN (SELECT id FROM applications)');
    const latestEvent = db.prepare('SELECT status FROM status_events WHERE app_id = ? ORDER BY id DESC LIMIT 1');
    const insertEvent = db.prepare('INSERT INTO status_events (app_id, status, date) VALUES (?, ?, ?)');
    for (const a of apps) {
      const last = latestEvent.get(a.id);
      if (!last) insertEvent.run(a.id, a.status, DATE_RE.test(a.signal_date) ? a.signal_date : today);
      else if (last.status !== a.status) insertEvent.run(a.id, a.status, today);
    }

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('md_sha256', mdHash());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { apps, diag };
}

async function sync(args) {
  if (!existsSync(MD_PATH)) {
    console.error(`Error: ${MD_PATH} not found — nothing to index.`);
    process.exit(1);
  }
  const states = loadStates();

  if (args.includes('--check')) {
    const { apps, diag } = parseTracker(states);
    console.error(`Parsed ${apps.length} data rows from ${MD_PATH}`);
    const issues = reportDiagnostics(diag);
    console.error('(--check — no index written)');
    process.exit(issues > 0 ? 1 : 0);
  }

  const DatabaseSync = await loadSqlite();
  const db = openDb(DatabaseSync);
  const { apps, diag } = syncIndex(db, states);
  console.error(`Indexed ${apps.length} applications from ${MD_PATH} into ${DB_PATH}`);
  reportDiagnostics(diag);
}

// query/history must never serve stale reads: if the markdown changed since
// the last sync (or was never synced), rebuild the index first.
function ensureFresh(db, states) {
  if (!existsSync(MD_PATH)) {
    console.error(`Error: ${MD_PATH} not found — the index has no source of truth to read from.`);
    process.exit(1);
  }
  const synced = db.prepare('SELECT value FROM meta WHERE key = ?').get('md_sha256');
  if (synced && synced.value === mdHash()) return;
  console.error(`(index stale — resyncing from ${MD_PATH})`);
  syncIndex(db, states);
}

// ── Query helpers ───────────────────────────────────────────────────

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const kv = args.find(a => a.startsWith(flag + '='));
  return kv ? kv.split('=').slice(1).join('=') : null;
}

function rowToMarkdown(r) {
  const clean = (v) => String(v ?? '').replace(/\|/g, '│').replace(/\r?\n/g, ' ');
  return `| ${clean(r.company)} | ${clean(r.signal)} | ${clean(r.signal_date)} | ${clean(r.icp_score)} | ${clean(r.status)} | ${clean(r.contact)} | ${clean(r.report)} | ${clean(r.notes)} |`;
}

async function query(args) {
  const DatabaseSync = await loadSqlite();
  const db = openDb(DatabaseSync);
  const states = loadStates();
  ensureFresh(db, states);

  const where = [];
  const params = [];
  const status = flagValue(args, '--status');
  if (status) {
    const canonical = normalizeStatus(status, states);
    if (!canonical) { console.error(`Error: unknown status "${status}". Canonical: ${states.labels.join(', ')}`); process.exit(1); }
    where.push('status = ?'); params.push(canonical);
  }
  const company = flagValue(args, '--company');
  if (company) { where.push('company LIKE ?'); params.push(`%${company}%`); }
  // --signal filters on the buying-signal role(s); --role is accepted as an alias.
  const signal = flagValue(args, '--signal') || flagValue(args, '--role');
  if (signal) { where.push('signal LIKE ?'); params.push(`%${signal}%`); }
  const since = flagValue(args, '--since');
  if (since) {
    if (!DATE_RE.test(since)) { console.error('Error: --since must be YYYY-MM-DD'); process.exit(1); }
    where.push('signal_date >= ?'); params.push(since);
  }
  const id = flagValue(args, '--id');
  if (id) { where.push('id = ?'); params.push(parseInt(id, 10)); }

  let sql = 'SELECT id, company, signal, signal_date, icp_score, status, contact, report, notes FROM applications'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC';
  const limit = parseInt(flagValue(args, '--limit') || '0', 10);
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }

  const rows = db.prepare(sql).all(...params);
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(HEADER);
    console.log(SEPARATOR);
    for (const r of rows) console.log(rowToMarkdown(r));
    console.error(`\n${rows.length} row(s)`); // stderr so stdout stays pipeable
  }
}

async function history(args) {
  const DatabaseSync = await loadSqlite();
  const db = openDb(DatabaseSync);
  ensureFresh(db, loadStates());
  const id = parseInt(flagValue(args, '--id') || '', 10);
  if (!Number.isInteger(id)) { console.error('Error: history requires --id N'); process.exit(1); }
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) { console.error(`Error: no account with id ${id}`); process.exit(1); }
  console.log(`#${app.id} ${app.company} — ${app.signal}`);
  for (const e of db.prepare('SELECT status, date FROM status_events WHERE app_id = ? ORDER BY id').all(id)) {
    console.log(`  ${e.date}  ${e.status}`);
  }
}

// ── Export (index → canonical markdown) ─────────────────────────────
// The inverse of sync: regenerates the canonical table from the index. Used by
// the round-trip tests (md → db → md must be lossless for clean input), and as
// a repaired copy the user can review and adopt by hand. It never touches
// applications.md unless explicitly asked to via --out.

async function exportMd(args) {
  const DatabaseSync = await loadSqlite();
  const db = openDb(DatabaseSync);
  ensureFresh(db, loadStates());
  const rows = db.prepare('SELECT * FROM applications ORDER BY pos').all();
  const out = [
    '# Applications Tracker',
    '',
    HEADER,
    SEPARATOR,
    ...rows.map(rowToMarkdown),
    '',
  ].join('\n');

  const outPath = flagValue(args, '--out');
  if (!outPath) {
    process.stdout.write(out);
    return;
  }
  if (existsSync(outPath) && statSync(outPath).isDirectory()) {
    console.error(`Error: --out ${outPath} is a directory — pass a file path.`);
    process.exit(1);
  }
  mkdirSync(dirname(outPath) || '.', { recursive: true });
  // Never silently clobber — whatever was there is backed up first.
  if (existsSync(outPath)) {
    copyFileSync(outPath, outPath + '.bak');
    console.error(`Existing ${outPath} backed up to ${outPath}.bak`);
  }
  writeFileSync(outPath, out, 'utf-8');
  console.error(`Exported ${rows.length} applications to ${outPath}`);
}

// ── Main ────────────────────────────────────────────────────────────

const COMMANDS = { sync, query, history, export: exportMd };

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.log('Usage: node tracker.mjs <sync|query|history|export> [flags]');
    console.log('See the header comment of this file for examples, or docs/SCRIPTS.md.');
    process.exit(command ? 1 : 0);
  }
  await fn(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
