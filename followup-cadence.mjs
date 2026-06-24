#!/usr/bin/env node
/**
 * followup-cadence.mjs — Sales Follow-up Cadence Tracker for Sales-Signals
 *
 * Parses the CRM tracker (icps/<slug>/prospects.md) + follow-ups.md, calculates
 * the next-touch cadence for active accounts across the SALES pipeline, extracts
 * decision-maker contacts, and flags accounts overdue for a follow-up.
 *
 * The tracker is the 8-column CRM table (see templates/crm-schema.md):
 *   | Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
 * Columns are mapped by HEADER NAME (not fixed position).
 *
 * Cadence is keyed off the SALES stage (states.yml):
 *   Contacted   → chase a non-reply (first + subsequent windows, capped)
 *   Replied     → fast cadence while the thread is warm
 *   Meeting     → post-meeting recap / next-step follow-up
 *   Opportunity → deal-nudge cadence to keep the deal moving
 *   Won / Lost / Disqualified → terminal, no follow-up
 *   New / Qualified → not yet contacted, no follow-up due
 *
 * Run: node followup-cadence.mjs             (JSON to stdout)
 *      node followup-cadence.mjs --summary   (human-readable dashboard)
 *      node followup-cadence.mjs --overdue-only
 *      node followup-cadence.mjs --contacted-days 10
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER / CAREER_OPS_FOLLOWUPS scope these to the active ICP (set by
// bin/signals.mjs). Unset → the legacy dual-layout defaults, so behaviour is
// identical when not run through the ICP launcher.
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const FOLLOWUPS_FILE = process.env.CAREER_OPS_FOLLOWUPS || join(CAREER_OPS, 'data/follow-ups.md');
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(CAREER_OPS, 'config/profile.yml');


// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const overdueOnly = args.includes('--overdue-only');
// --contacted-days is the sales-stage replacement for the old --applied-days flag;
// the legacy flag is still accepted as an alias so existing callers keep working.
const contactedDaysIdx = args.indexOf('--contacted-days') !== -1
  ? args.indexOf('--contacted-days')
  : args.indexOf('--applied-days');
const contactedDaysOverride = contactedDaysIdx !== -1 ? parseInt(args[contactedDaysIdx + 1], 10) : null;

// --- Cadence config (SALES stages) ---
// Windows are in days. *_max_followups caps the chase before an account goes
// "cold". Terminal stages (Won/Lost/Disqualified) never produce a follow-up.
export const DEFAULT_CADENCE = {
  contacted_first: 4,         // first chase if no reply N days after outreach
  contacted_subsequent: 4,    // each subsequent chase
  contacted_max_followups: 3, // then mark the account cold
  replied_initial: 1,         // reply fast while the thread is warm
  replied_subsequent: 2,      // keep the warm cadence tight
  meeting_followup: 1,        // post-meeting recap / next step
  opportunity_nudge: 5,       // deal-nudge cadence to keep momentum
};

const PROFILE_CADENCE_KEYS = {
  contacted_first_days: 'contacted_first',
  contacted_subsequent_days: 'contacted_subsequent',
  contacted_max_followups: 'contacted_max_followups',
  replied_initial_days: 'replied_initial',
  replied_subsequent_days: 'replied_subsequent',
  meeting_followup_days: 'meeting_followup',
  opportunity_nudge_days: 'opportunity_nudge',
};

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function loadProfileCadence(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return {};
  let raw;
  try {
    raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
  const source = raw.followup_cadence || {};
  const cadence = {};
  for (const [profileKey, cadenceKey] of Object.entries(PROFILE_CADENCE_KEYS)) {
    const parsed = positiveInteger(source[profileKey]);
    if (parsed !== null) cadence[cadenceKey] = parsed;
  }
  return cadence;
}

export function resolveCadenceConfig({ profilePath = PROFILE_FILE, contactedDays = contactedDaysOverride } = {}) {
  const cadence = { ...DEFAULT_CADENCE, ...loadProfileCadence(profilePath) };
  const cliContacted = positiveInteger(contactedDays);
  if (cliContacted !== null) cadence.contacted_first = cliContacted;
  return cadence;
}

const CADENCE = resolveCadenceConfig();

// --- Status normalization (canonical SALES states; mirrors states.yml) ---
const ALIASES = {
  'new': 'new', 'nuevo': 'new', 'detected': 'new', 'signal': 'new',
  'qualified': 'qualified', 'cualificado': 'qualified', 'qualify': 'qualified',
  'contacted': 'contacted', 'contactado': 'contacted', 'outreach': 'contacted', 'reached_out': 'contacted',
  'replied': 'replied', 'respondido': 'replied', 'responded': 'replied',
  'meeting': 'meeting', 'reunion': 'meeting', 'meeting_booked': 'meeting', 'demo': 'meeting',
  'opportunity': 'opportunity', 'oportunidad': 'opportunity', 'deal': 'opportunity', 'opp': 'opportunity',
  'won': 'won', 'ganado': 'won', 'closed_won': 'won', 'customer': 'won',
  'lost': 'lost', 'perdido': 'lost', 'closed_lost': 'lost',
  'disqualified': 'disqualified', 'descalificado': 'disqualified', 'disqualify': 'disqualified',
  'not_a_fit': 'disqualified', 'no_fit': 'disqualified', 'skip': 'disqualified',
};

// Stages that warrant an outbound follow-up. New/Qualified are pre-outreach;
// Won/Lost/Disqualified are terminal — none of those produce a follow-up.
const ACTIONABLE_STATUSES = ['contacted', 'replied', 'meeting', 'opportunity'];

export function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

// --- Date helpers ---
function today() {
  return new Date(new Date().toISOString().split('T')[0]);
}

export function parseDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return null;
  // The shape regex accepts calendar-invalid dates (e.g. 2026-13-45), which the
  // Date constructor turns into an Invalid Date. Reject those so a later
  // toISOString() can't crash the whole run.
  const d = new Date(dateStr.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

export function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().split('T')[0];
}

// Header-name column mapping (CRM schema). Columns are located by header NAME,
// never by fixed position (see templates/crm-schema.md / normalize-statuses.mjs).
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
 * Detect CRM column indices by header NAME (Company + Status minimum).
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

// --- Parse the CRM prospects.md (one row per account) ---
function parseTracker() {
  if (!existsSync(APPS_FILE)) return [];
  const content = readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const cols = detectColumns(lines);
  if (!cols) return [];
  const maxIdx = Math.max(...Object.values(cols));
  const cell = (parts, key) => (cols[key] != null ? (parts[cols[key]] || '') : '');

  const entries = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= maxIdx) continue;
    const company = cell(parts, 'company');
    // Skip the header row itself + empty rows.
    if (!company || company.toLowerCase() === 'company') continue;
    entries.push({
      company,
      signal: cell(parts, 'signal'),
      date: cell(parts, 'signaldate'),
      score: cell(parts, 'score'),
      status: cell(parts, 'status'),
      contact: cell(parts, 'contact'),
      report: cell(parts, 'report'),
      notes: cell(parts, 'notes'),
    });
  }
  return entries;
}

// --- Parse follow-ups.md (company-keyed touch history) ---
// Accounts are keyed by Company in the CRM (no app number). Each row records a
// prior outbound touch so the cadence can count follow-ups and find the last one.
function parseFollowups() {
  if (!existsSync(FOLLOWUPS_FILE)) return [];
  const content = readFileSync(FOLLOWUPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const cols = detectFollowupColumns(lines);
  if (!cols) return [];
  const maxIdx = Math.max(...Object.values(cols));
  const cell = (parts, key) => (cols[key] != null ? (parts[cols[key]] || '') : '');

  const entries = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= maxIdx) continue;
    const company = cell(parts, 'company');
    if (!company || company.toLowerCase() === 'company') continue;
    entries.push({
      company,
      date: cell(parts, 'date'),
      channel: cell(parts, 'channel'),
      contact: cell(parts, 'contact'),
      notes: cell(parts, 'notes'),
    });
  }
  return entries;
}

// Follow-up history is also header-name mapped (Company + Date minimum).
const FOLLOWUP_HEADER_ALIASES = {
  'company': 'company', 'empresa': 'company',
  'date': 'date', 'fecha': 'date',
  'channel': 'channel', 'canal': 'channel',
  'contact': 'contact', 'contacto': 'contact',
  'notes': 'notes', 'notas': 'notes',
};

function detectFollowupColumns(allLines) {
  for (const line of allLines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('date')) continue;
    const map = {};
    cells.forEach((c, i) => { if (FOLLOWUP_HEADER_ALIASES[c] != null) map[FOLLOWUP_HEADER_ALIASES[c]] = i; });
    if (map.company != null && map.date != null) return map;
  }
  return null;
}

// --- Extract contacts from notes ---
function extractContacts(notes) {
  if (!notes) return [];
  const contacts = [];
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
  const emails = notes.match(emailRegex) || [];
  for (const email of emails) {
    // Try to extract name before email: "Emailed Name at" or "contact: Name"
    let name = null;
    const beforeEmail = notes.substring(0, notes.indexOf(email));
    const nameMatch = beforeEmail.match(/(?:Emailed|emailed|contact[:\s]+|to\s+)([A-Z][a-z]+ ?[A-Z]?[a-z]*)\s*(?:at|@|$)/i);
    if (nameMatch) name = nameMatch[1].trim();
    contacts.push({ email, name });
  }
  return contacts;
}

// --- Resolve report path ---
function resolveReportPath(reportField) {
  const match = reportField.match(/\]\(([^)]+)\)/);
  if (!match) return null;
  const fullPath = join(CAREER_OPS, match[1]);
  return existsSync(fullPath) ? match[1] : null;
}

// --- Compute urgency (SALES stages) ---
// `daysSinceSignal` is days since the signal/stage date for the account.
export function computeUrgency(status, daysSinceSignal, daysSinceLastFollowup, followupCount) {
  if (status === 'contacted') {
    // Chase a non-reply: first window off the signal date, then subsequent
    // windows off the last touch, capped at contacted_max_followups → cold.
    if (followupCount >= CADENCE.contacted_max_followups) return 'cold';
    if (followupCount === 0 && daysSinceSignal >= CADENCE.contacted_first) return 'overdue';
    if (followupCount > 0 && daysSinceLastFollowup !== null && daysSinceLastFollowup >= CADENCE.contacted_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'replied') {
    // Warm thread — reply fast, then keep a tight cadence.
    if (daysSinceLastFollowup === null && daysSinceSignal < CADENCE.replied_initial) return 'urgent';
    if (daysSinceLastFollowup !== null && daysSinceLastFollowup >= CADENCE.replied_subsequent) return 'overdue';
    if (daysSinceLastFollowup === null && daysSinceSignal >= CADENCE.replied_initial) return 'overdue';
    return 'waiting';
  }
  if (status === 'meeting') {
    // Post-meeting recap / next-step is due quickly.
    const since = daysSinceLastFollowup !== null ? daysSinceLastFollowup : daysSinceSignal;
    if (since >= CADENCE.meeting_followup) return 'overdue';
    return 'waiting';
  }
  if (status === 'opportunity') {
    // Deal-nudge cadence to keep momentum on an open deal.
    const since = daysSinceLastFollowup !== null ? daysSinceLastFollowup : daysSinceSignal;
    if (since >= CADENCE.opportunity_nudge) return 'overdue';
    return 'waiting';
  }
  return 'waiting';
}

// --- Compute next follow-up date (SALES stages) ---
export function computeNextFollowupDate(status, signalDate, lastFollowupDate, followupCount) {
  if (status === 'contacted') {
    if (followupCount >= CADENCE.contacted_max_followups) return null; // cold
    if (followupCount === 0) return addDays(parseDate(signalDate), CADENCE.contacted_first);
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.contacted_subsequent);
    return addDays(parseDate(signalDate), CADENCE.contacted_first);
  }
  if (status === 'replied') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.replied_subsequent);
    return addDays(parseDate(signalDate), CADENCE.replied_initial);
  }
  if (status === 'meeting') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.meeting_followup);
    return addDays(parseDate(signalDate), CADENCE.meeting_followup);
  }
  if (status === 'opportunity') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), CADENCE.opportunity_nudge);
    return addDays(parseDate(signalDate), CADENCE.opportunity_nudge);
  }
  return null;
}

// --- Main analysis ---
function analyze() {
  const apps = parseTracker();
  if (apps.length === 0) {
    return { error: 'No accounts found in tracker.' };
  }

  const followups = parseFollowups();

  // Group follow-ups by company (the CRM account key).
  const followupsByCompany = new Map();
  for (const fu of followups) {
    const key = fu.company.toLowerCase();
    if (!followupsByCompany.has(key)) followupsByCompany.set(key, []);
    followupsByCompany.get(key).push(fu);
  }

  const now = today();
  const entries = [];

  for (const app of apps) {
    const normalized = normalizeStatus(app.status);
    if (!ACTIONABLE_STATUSES.includes(normalized)) continue;

    const signalDate = parseDate(app.date);
    if (!signalDate) continue;

    const daysSinceSignal = daysBetween(signalDate, now);
    const acctFollowups = followupsByCompany.get(app.company.toLowerCase()) || [];
    const followupCount = acctFollowups.length;

    // Find most recent follow-up
    let lastFollowupDate = null;
    let daysSinceLastFollowup = null;
    if (acctFollowups.length > 0) {
      const sorted = acctFollowups.sort((a, b) => (a.date > b.date ? -1 : 1));
      lastFollowupDate = sorted[0].date;
      const lastDate = parseDate(lastFollowupDate);
      if (lastDate) daysSinceLastFollowup = daysBetween(lastDate, now);
    }

    const urgency = computeUrgency(normalized, daysSinceSignal, daysSinceLastFollowup, followupCount);
    const nextFollowupDate = computeNextFollowupDate(normalized, app.date, lastFollowupDate, followupCount);
    const nextDate = nextFollowupDate ? parseDate(nextFollowupDate) : null;
    const daysUntilNext = nextDate ? daysBetween(now, nextDate) : null;

    // Prefer the structured Contact column; fall back to e-mails mined from Notes.
    const contacts = extractContacts(`${app.contact} ${app.notes}`.trim());
    const reportPath = resolveReportPath(app.report);

    entries.push({
      company: app.company,
      signal: app.signal,
      signalDate: app.date,
      status: normalized,
      score: app.score,
      contact: app.contact,
      notes: app.notes,
      reportPath,
      contacts,
      daysSinceSignal,
      daysSinceLastFollowup,
      followupCount,
      urgency,
      nextFollowupDate,
      daysUntilNext,
    });
  }

  // Sort by urgency priority: urgent > overdue > waiting > cold
  const urgencyOrder = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };
  entries.sort((a, b) => (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9));

  const filtered = overdueOnly
    ? entries.filter(e => e.urgency === 'overdue' || e.urgency === 'urgent')
    : entries;

  return {
    metadata: {
      analysisDate: now.toISOString().split('T')[0],
      totalTracked: apps.length,
      actionable: entries.length,
      overdue: entries.filter(e => e.urgency === 'overdue').length,
      urgent: entries.filter(e => e.urgency === 'urgent').length,
      cold: entries.filter(e => e.urgency === 'cold').length,
      waiting: entries.filter(e => e.urgency === 'waiting').length,
    },
    entries: filtered,
    cadenceConfig: CADENCE,
  };
}

// --- Summary mode ---
function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }

  const { metadata, entries } = result;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  Sales Follow-up Cadence Dashboard — ${metadata.analysisDate}`);
  console.log(`  ${metadata.totalTracked} total accounts, ${metadata.actionable} actionable`);
  console.log(`${'='.repeat(70)}\n`);

  if (entries.length === 0) {
    console.log('  No active accounts to follow up on. Contact some prospects first.\n');
    return;
  }

  // Status summary
  const urgencyIcon = { urgent: 'URGENT', overdue: 'OVERDUE', waiting: 'waiting', cold: 'COLD' };
  console.log(`  ${metadata.urgent} urgent | ${metadata.overdue} overdue | ${metadata.waiting} waiting | ${metadata.cold} cold\n`);

  // Table header
  console.log('  ' + 'Company'.padEnd(18) + 'Status'.padEnd(14) + 'Days'.padEnd(6) + 'F/U'.padEnd(5) + 'Next'.padEnd(13) + 'Urgency'.padEnd(10) + 'Contact');
  console.log('  ' + '-'.repeat(80));

  for (const e of entries) {
    const urgLabel = urgencyIcon[e.urgency] || e.urgency;
    const nextStr = e.nextFollowupDate || '-';
    const contactStr = e.contacts.length > 0
      ? e.contacts[0].email
      : (e.contact && e.contact !== '—' ? e.contact.substring(0, 20) : '-');
    console.log(
      '  ' +
      e.company.substring(0, 17).padEnd(18) +
      e.status.padEnd(14) +
      String(e.daysSinceSignal).padEnd(6) +
      String(e.followupCount).padEnd(5) +
      nextStr.padEnd(13) +
      urgLabel.padEnd(10) +
      contactStr
    );
  }

  console.log('');
}

// --- Run (CLI only; guarded so the module is safely importable for tests) ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = analyze();

  if (summaryMode) {
    printSummary(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.error) process.exit(1);
}
