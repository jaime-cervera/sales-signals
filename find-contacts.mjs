#!/usr/bin/env node

/**
 * find-contacts.mjs — find decision-maker contact(s) for a qualified account via
 * Unipile LinkedIn people search (Sales Navigator preferred), and write the best
 * contact into the account's CRM row + dossier (Unit 5.1).
 *
 *   node bin/signals.mjs contacts --icp <slug> --account "<Company>" [--titles "VP Eng,Head of ML"]
 *
 * Degrades gracefully (the contact step never blocks qualification): missing
 * creds / no Sales Nav entitlement / zero matches → "no contact found", exit 0.
 * Never auto-messages (scope boundary). All output is REDACTED of secrets by the
 * client. searchPeople is dependency-injected so tests run without the network.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

// Header-name CRM column mapping (mirrors normalize-statuses / the other parsers).
const HEADER_ALIASES = {
  company: 'company', empresa: 'company',
  signal: 'signal', signaldate: 'signaldate', 'signal date': 'signaldate', date: 'signaldate',
  icpscore: 'score', 'icp score': 'score', score: 'score',
  status: 'status', estado: 'status',
  contact: 'contact', contacto: 'contact',
  report: 'report', informe: 'report',
  notes: 'notes', notas: 'notes',
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

/**
 * Rank contacts by how well their title matches the target decision-maker titles,
 * dedupe by profileId/linkedinUrl, return the top `max`.
 */
export function pickBestContacts(contacts, targetTitles = [], max = 3) {
  const targets = targetTitles.map(t => String(t).toLowerCase()).filter(Boolean);
  const seen = new Set();
  const scored = [];
  for (const c of Array.isArray(contacts) ? contacts : []) {
    if (!c || !c.name) continue;
    const key = c.profileId || c.linkedinUrl || c.name;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(c.title || '').toLowerCase();
    let score = 0;
    for (const t of targets) {
      for (const word of t.split(/\s+/)) {
        if (word.length > 2 && title.includes(word)) score += 1;
      }
    }
    scored.push({ ...c, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, max).map(({ _score, ...c }) => c);
}

/** Format a contact for the CRM Contact column (one primary contact). */
export function formatContactCell(contact) {
  if (!contact) return '';
  return contact.linkedinUrl ? `${contact.name} <${contact.linkedinUrl}>` : contact.name;
}

/** Build the dossier `## Contacts` section markdown. */
export function formatContactsSection(contacts) {
  const lines = contacts.map(c =>
    `- ${c.name}${c.title ? ` — ${c.title}` : ''}${c.linkedinUrl ? ` — ${c.linkedinUrl}` : ''}${c.profileId ? ` — id:${c.profileId}` : ''}`);
  return `## Contacts\n\n${lines.join('\n')}\n`;
}

/**
 * Update the Contact column of an account's row in a CRM tracker file. Idempotent
 * (writing the same contact twice is a no-op). Returns true if the row was found.
 */
export function writeContactToTracker(trackerPath, company, contactCell) {
  if (!existsSync(trackerPath)) return false;
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const cols = detectColumns(lines);
  if (!cols) return false;
  const target = normalizeCompany(company);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || line.includes('---')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= Math.max(...Object.values(cols))) continue;
    if (normalizeCompany(parts[cols.company]) !== target) continue;
    if (parts[cols.company].toLowerCase() === 'company') continue;
    if (parts[cols.contact] === contactCell) { found = true; break; } // idempotent
    parts[cols.contact] = contactCell || parts[cols.contact];
    lines[i] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
    found = true;
    break;
  }
  if (found) writeFileSync(trackerPath, lines.join('\n'));
  return found;
}

/** Upsert the `## Contacts` section into a dossier report. Idempotent (a no-op
 *  re-run leaves the file byte-identical). Line-based. Empty contacts → no-op. */
export function writeContactsToReport(reportPath, contacts) {
  if (!reportPath || !existsSync(reportPath)) return false;
  if (!Array.isArray(contacts) || contacts.length === 0) return false;
  const sectionLines = formatContactsSection(contacts).replace(/\n+$/, '').split('\n');
  const lines = readFileSync(reportPath, 'utf-8').split('\n');

  // Locate any existing ## Contacts section [start, end).
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (/^##\s+Contacts\s*$/.test(lines[i])) { start = i; break; } }
  let before; let after;
  if (start === -1) {
    before = [...lines]; after = [];
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { end = i; break; } }
    before = lines.slice(0, start); after = lines.slice(end);
  }
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  while (after.length && after[0].trim() === '') after.shift();

  // Stable shape regardless of append-vs-replace → idempotent.
  const rebuilt = [...before, '', ...sectionLines];
  if (after.length) rebuilt.push('', ...after); else rebuilt.push('');
  const next = rebuilt.join('\n');
  if (next === lines.join('\n')) return false;
  writeFileSync(reportPath, next);
  return true;
}

/** Resolve the dossier path for an account from its tracker row's Report cell. */
export function reportPathForAccount(trackerPath, company) {
  if (!existsSync(trackerPath)) return null;
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const cols = detectColumns(lines);
  if (!cols || cols.report == null) return null;
  const target = normalizeCompany(company);
  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= Math.max(...Object.values(cols))) continue;
    if (normalizeCompany(parts[cols.company]) !== target) continue;
    const m = (parts[cols.report] || '').match(/\]\(([^)]+)\)/);
    if (!m) return null;
    return join(dirname(trackerPath), m[1]);
  }
  return null;
}

/**
 * Orchestrate contact discovery for one account. searchPeople + checkSalesNavigator
 * are injected (default: the real Unipile client) so tests run offline.
 * @returns {Promise<{contacts:Array, salesNav:boolean, degraded:false|string}>}
 */
export async function findContacts({ company, titles = [], deps = {} } = {}) {
  const searchPeople = deps.searchPeople || (await import('./lib/unipile-client.mjs')).searchPeople;
  const checkSalesNavigator = deps.checkSalesNavigator
    || (await import('./lib/unipile-client.mjs')).checkSalesNavigator;

  let salesNav = false;
  try {
    const sn = await checkSalesNavigator();
    salesNav = !!sn.available;
  } catch { /* treat as not-entitled */ }

  const keywords = titles.length ? titles.join(' OR ') : 'VP OR Head OR Director';
  try {
    const { contacts } = await searchPeople({
      company,
      keywords,
      api: salesNav ? 'sales_navigator' : 'classic',
    });
    return { contacts: pickBestContacts(contacts, titles), salesNav, degraded: false };
  } catch (e) {
    if (e && e.code === 'no_entitlement' && salesNav === false) {
      // already classic — nothing else to try
    } else if (e && e.code === 'no_entitlement') {
      // entitlement vanished mid-call → retry classic once
      try {
        const { contacts } = await searchPeople({ company, keywords, api: 'classic' });
        return { contacts: pickBestContacts(contacts, titles), salesNav: false, degraded: 'no_entitlement' };
      } catch (e2) { return { contacts: [], salesNav, degraded: e2.code || 'error' }; }
    }
    return { contacts: [], salesNav, degraded: (e && e.code) || 'error' };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  let account; let titles = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') account = argv[++i];
    else if (argv[i] === '--titles') titles = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return { account, titles };
}

async function main() {
  const { account, titles } = parseArgs(process.argv.slice(2));
  if (!account) {
    console.error('Usage: node bin/signals.mjs contacts --icp <slug> --account "<Company>" [--titles "VP Eng,Head of ML"]');
    process.exit(1);
  }
  const trackerPath = process.env.CAREER_OPS_TRACKER || join(CAREER_OPS, 'prospects.md');

  const { contacts, salesNav, degraded } = await findContacts({ company: account, titles });

  if (contacts.length === 0) {
    const why = degraded === 'missing_credentials'
      ? 'Unipile not configured (.env)'
      : degraded === 'no_entitlement'
        ? 'no Sales Navigator entitlement'
        : degraded || 'no matches';
    console.log(`No contact found for "${account}" (${why}). Qualification is still usable; you can retry later.`);
    process.exit(0);
  }

  const best = contacts[0];
  const wrote = writeContactToTracker(trackerPath, account, formatContactCell(best));
  // Also persist the full list into the account's dossier ## Contacts section.
  const reportPath = reportPathForAccount(trackerPath, account);
  const wroteReport = reportPath ? writeContactsToReport(reportPath, contacts) : false;

  console.log(`Found ${contacts.length} contact(s) for "${account}"${salesNav ? ' (Sales Navigator)' : ' (Classic)'}:`);
  for (const c of contacts) console.log(`  • ${c.name}${c.title ? ` — ${c.title}` : ''}${c.linkedinUrl ? ` — ${c.linkedinUrl}` : ''}`);
  if (!wrote) console.log(`(Account "${account}" not found in the tracker — qualify it first to persist the contact.)`);
  else if (wroteReport) console.log(`Contacts written to the CRM row + dossier.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    // err.message is redacted by the client; never print raw secrets.
    console.error(`find-contacts failed: ${err.message}`);
    process.exit(1);
  });
}
