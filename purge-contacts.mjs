#!/usr/bin/env node

/**
 * purge-contacts.mjs — GDPR purge of decision-maker PII from an ICP's CRM + dossiers
 * (Unit 5.2). Removes a contact (by name/LinkedIn URL/profile id) or all contacts
 * for an account from `prospects.md` (the Contact column) and the account dossiers
 * (`reports/*.md` `## Contacts` section).
 *
 *   node bin/signals.mjs purge-contacts --icp <slug> --contact "<name|url|id>"
 *   node bin/signals.mjs purge-contacts --icp <slug> --account "<Company>"
 *
 * Idempotent. The minimal "right to erasure" capability the plan ships now
 * (formal retention policy deferred as compliance debt). Reads CAREER_OPS_TRACKER
 * + CAREER_OPS_REPORTS so it is scoped to the active ICP.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

const HEADER_ALIASES = {
  company: 'company', signal: 'signal', signaldate: 'signaldate', date: 'signaldate',
  icpscore: 'score', score: 'score', status: 'status', contact: 'contact',
  report: 'report', notes: 'notes',
};
function detectColumns(lines) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('contact')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (map.company != null && map.contact != null) return map;
  }
  return null;
}
function normalizeCompany(name) {
  return String(name || '').toLowerCase()
    .replace(/[()]/g, '').replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/** Precisely detect a markdown table separator row (cells are only -/: ) so a data
 *  cell that happens to contain '---' is never skipped during an erasure. */
function isSeparatorRow(line) {
  const cells = line.split('|').map(s => s.trim()).filter(Boolean);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

/**
 * Clear matching Contact cells in a CRM tracker. By `account` → clear that row's
 * Contact to "—". By `contact` → clear any Contact cell containing the identifier.
 * @returns {number} rows changed.
 */
export function purgeTracker(trackerPath, { account, contact } = {}) {
  if (!existsSync(trackerPath)) return 0;
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const cols = detectColumns(lines);
  if (!cols) return 0;
  const acct = account ? normalizeCompany(account) : null;
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || isSeparatorRow(line)) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= Math.max(...Object.values(cols))) continue;
    if (parts[cols.company].toLowerCase() === 'company') continue;
    const cell = parts[cols.contact] || '';
    const isPlaceholder = cell === '' || cell === '—' || cell === '-';
    const matchAccount = acct && normalizeCompany(parts[cols.company]) === acct;
    const matchContact = contact && cell.toLowerCase().includes(String(contact).toLowerCase());
    if (!isPlaceholder && (matchAccount || matchContact)) {
      parts[cols.contact] = '—';
      lines[i] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
      changed += 1;
    }
  }
  if (changed) writeFileSync(trackerPath, lines.join('\n'));
  return changed;
}

/** Locate the `## Contacts` section as a [start, end) line range, or null. */
function contactsSection(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Contacts\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/**
 * Purge contact lines from a dossier's `## Contacts` section. By `account` → remove
 * the whole section. By `contact` → remove only lines containing the identifier.
 * Line-based (robust to EOF — no fragile regex). @returns {boolean} changed.
 */
export function purgeReport(reportPath, { account, contact } = {}) {
  if (!reportPath || !existsSync(reportPath)) return false;
  const lines = readFileSync(reportPath, 'utf-8').split('\n');
  const sec = contactsSection(lines);
  if (!sec) return false;
  let next;
  if (account) {
    next = [...lines.slice(0, sec.start), ...lines.slice(sec.end)];
  } else if (contact) {
    const needle = String(contact).toLowerCase();
    const body = lines.slice(sec.start + 1, sec.end)
      .filter(l => !(l.trim().startsWith('-') && l.toLowerCase().includes(needle)));
    next = [...lines.slice(0, sec.start + 1), ...body, ...lines.slice(sec.end)];
  } else {
    return false;
  }
  if (next.join('\n') === lines.join('\n')) return false;
  writeFileSync(reportPath, next.join('\n'));
  return true;
}

/** List dossier report files in a reports dir. */
function listReports(reportsDir) {
  if (!reportsDir || !existsSync(reportsDir)) return [];
  return readdirSync(reportsDir).filter(f => f.endsWith('.md') && !f.endsWith('-RESERVED.md'))
    .map(f => join(reportsDir, f));
}

function parseArgs(argv) {
  let account; let contact;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') account = argv[++i];
    else if (argv[i] === '--contact') contact = argv[++i];
  }
  return { account, contact };
}

function main() {
  const { account, contact } = parseArgs(process.argv.slice(2));
  if (!account && !contact) {
    console.error('Usage: node bin/signals.mjs purge-contacts --icp <slug> (--contact "<name|url|id>" | --account "<Company>")');
    process.exit(1);
  }
  if (contact && String(contact).trim().length < 3) {
    console.error('--contact must be at least 3 characters (use a name, LinkedIn URL slug, or profile id) to avoid clearing unrelated rows.');
    process.exit(1);
  }
  const trackerPath = process.env.CAREER_OPS_TRACKER || join(CAREER_OPS, 'prospects.md');
  const reportsDir = process.env.CAREER_OPS_REPORTS || join(CAREER_OPS, 'reports');

  const rows = purgeTracker(trackerPath, { account, contact });
  let reportsChanged = 0;
  for (const rp of listReports(reportsDir)) {
    if (purgeReport(rp, { account, contact })) reportsChanged += 1;
  }
  const subject = account ? `account "${account}"` : `contact "${contact}"`;
  console.log(`Purged ${subject}: ${rows} tracker row(s), ${reportsChanged} dossier(s) updated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
