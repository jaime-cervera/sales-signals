#!/usr/bin/env node

/**
 * find-contacts-tests.mjs — tests for decision-maker extraction (Unit 5.1).
 * searchPeople / checkSalesNavigator are dependency-injected (no network).
 * Registered in test-all.mjs scripts[].
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  findContacts, pickBestContacts, writeContactToTracker, formatContactCell, writeContactsToReport,
} from './find-contacts.mjs';
import { mapPerson } from './lib/unipile-client.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(ROOT, 'test/fixtures/payloads/unipile', f), 'utf-8'));

let passed = 0; let failed = 0;
function ok(c, m) { if (c) { console.log(`PASS ${m}`); passed++; } else { console.error(`FAIL ${m}`); failed++; } }

const CRM = '# Prospects Tracker\n\n' +
  '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
  '|---------|--------|------------|----------|--------|---------|--------|-------|\n' +
  '| Acme | LLMOps Engineer | 2026-06-15 | 4.4/5 | Qualified | — | — | strong |\n';

// contacts mapped from the classic fixture (VP Eng + Head of ML)
const CONTACTS = fx('people-classic.json').items.map(mapPerson);

// ── pickBestContacts ranks by title match + dedupes ────────────────────────
{
  const best = pickBestContacts(CONTACTS, ['VP Engineering'], 3);
  ok(best[0].title.includes('VP of Engineering'), 'pickBestContacts ranks the VP Eng match first');
  const dup = pickBestContacts([CONTACTS[0], CONTACTS[0]], ['VP Engineering']);
  ok(dup.length === 1, 'pickBestContacts dedupes the same profileId');
}

// ── findContacts uses Sales Nav api when entitled (routing asserted) ───────
{
  const apis = [];
  const deps = {
    checkSalesNavigator: async () => ({ available: true, features: ['sales_navigator'] }),
    searchPeople: async ({ api }) => { apis.push(api); return { contacts: CONTACTS, cursor: null }; },
  };
  const res = await findContacts({ company: 'Acme', titles: ['VP Engineering', 'Head of ML'], deps });
  ok(res.salesNav === true && res.degraded === false, 'findContacts uses Sales Nav when entitled');
  ok(apis[0] === 'sales_navigator', 'entitled → searchPeople called with api=sales_navigator');
  ok(res.contacts.length >= 1 && res.contacts[0].name === 'Piyush Narwani', 'findContacts returns the best-ranked contact');
}

// ── Not entitled (but search succeeds) → routes to classic ─────────────────
{
  const apis = [];
  const deps = {
    checkSalesNavigator: async () => ({ available: false, features: [] }),
    searchPeople: async ({ api }) => { apis.push(api); return { contacts: CONTACTS, cursor: null }; },
  };
  const res = await findContacts({ company: 'Acme', titles: ['VP Engineering'], deps });
  ok(apis[0] === 'classic', 'not entitled → searchPeople called with api=classic');
  ok(res.salesNav === false && res.degraded === false && res.contacts.length >= 1, 'classic path still returns contacts');
}

// ── P1: entitlement revoked mid-call → retry once with classic ─────────────
{
  const apis = [];
  let call = 0;
  const deps = {
    checkSalesNavigator: async () => ({ available: true, features: ['sales_navigator'] }),
    searchPeople: async ({ api }) => {
      apis.push(api);
      call += 1;
      if (call === 1) { const e = new Error('403'); e.code = 'no_entitlement'; throw e; }
      return { contacts: CONTACTS, cursor: null };
    },
  };
  const res = await findContacts({ company: 'Acme', titles: ['VP Engineering'], deps });
  ok(call === 2 && apis[0] === 'sales_navigator' && apis[1] === 'classic',
    'mid-call no_entitlement → retries once with classic');
  ok(res.degraded === 'no_entitlement' && res.salesNav === false && res.contacts.length >= 1,
    'retry surfaces degraded=no_entitlement, salesNav=false, and still returns contacts');
}

// ── Writes the best contact into the CRM Contact column (idempotent) ────────
{
  const dir = mkdtempSync(join(tmpdir(), 'fc-'));
  const tracker = join(dir, 'prospects.md');
  writeFileSync(tracker, CRM);
  const best = pickBestContacts(CONTACTS, ['VP Engineering'])[0];
  const cell = formatContactCell(best);
  ok(writeContactToTracker(tracker, 'Acme', cell), 'writeContactToTracker finds the Acme row');
  const after = readFileSync(tracker, 'utf-8');
  ok(after.includes(cell) && after.includes('Piyush Narwani'), 'Contact column now holds the contact');
  // idempotent
  const before2 = readFileSync(tracker, 'utf-8');
  writeContactToTracker(tracker, 'Acme', cell);
  ok(readFileSync(tracker, 'utf-8') === before2, 're-writing the same contact is idempotent');
  // unknown account → not found, no change
  ok(writeContactToTracker(tracker, 'NoSuchCo', cell) === false, 'unknown account → not written');
  rmSync(dir, { recursive: true, force: true });
}

// ── Dossier ## Contacts section upsert ─────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'fcr-'));
  const report = join(dir, '001-acme.md');
  writeFileSync(report, '# 001 — Acme\n\n**Status:** Qualified\n\n## Signal analysis\n\nstrong.\n');
  ok(writeContactsToReport(report, pickBestContacts(CONTACTS, ['VP Engineering'])), 'writeContactsToReport adds a ## Contacts section');
  ok(/## Contacts/.test(readFileSync(report, 'utf-8')), 'report has the Contacts section');
  rmSync(dir, { recursive: true, force: true });
}

// ── Graceful: no creds / zero matches → empty + degraded reason ────────────
{
  const deps = {
    checkSalesNavigator: async () => ({ available: false, features: [], error: 'missing_credentials' }),
    searchPeople: async () => { const e = new Error('x'); e.code = 'missing_credentials'; throw e; },
  };
  const res = await findContacts({ company: 'Acme', titles: ['VP'], deps });
  ok(res.contacts.length === 0 && res.degraded === 'missing_credentials', 'no creds → empty contacts + degraded reason (no crash)');
}
{
  const deps = {
    checkSalesNavigator: async () => ({ available: true, features: ['sales_navigator'] }),
    searchPeople: async () => ({ contacts: [], cursor: null }),
  };
  const res = await findContacts({ company: 'Ghost', titles: ['VP'], deps });
  ok(res.contacts.length === 0 && res.degraded === false, 'zero matches → empty (not an error)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
