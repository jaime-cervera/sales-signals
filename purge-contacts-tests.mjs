#!/usr/bin/env node

/**
 * purge-contacts-tests.mjs — tests for the GDPR contact purge (Unit 5.2).
 * Registered in test-all.mjs scripts[].
 */

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { purgeTracker, purgeReport } from './purge-contacts.mjs';

let passed = 0; let failed = 0;
function ok(c, m) { if (c) { console.log(`PASS ${m}`); passed++; } else { console.error(`FAIL ${m}`); failed++; } }

const HEADER = '# Prospects Tracker\n\n' +
  '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
  '|---------|--------|------------|----------|--------|---------|--------|-------|\n';
const TRACKER = HEADER +
  '| Acme | LLMOps | 2026-06-15 | 4.4/5 | Contacted | Jane Roe <https://www.linkedin.com/in/jane-roe> | — | x |\n' +
  '| Globex | Data Eng | 2026-06-10 | 3.8/5 | Contacted | John Doe <https://www.linkedin.com/in/john-doe> | — | y |\n';

// ── purge by --account clears that row's Contact only ──────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  const tracker = join(dir, 'prospects.md');
  writeFileSync(tracker, TRACKER);
  const changed = purgeTracker(tracker, { account: 'Acme' });
  const after = readFileSync(tracker, 'utf-8');
  ok(changed === 1, 'purge --account changes exactly 1 row');
  ok(!after.includes('Jane Roe') && after.includes('John Doe'), 'Acme contact purged; Globex untouched');
  // idempotent
  ok(purgeTracker(tracker, { account: 'Acme' }) === 0, 're-purging the same account is a no-op');
  rmSync(dir, { recursive: true, force: true });
}

// ── purge by --contact clears any matching Contact cell ────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'pc2-'));
  const tracker = join(dir, 'prospects.md');
  writeFileSync(tracker, TRACKER);
  const changed = purgeTracker(tracker, { contact: 'john-doe' });
  const after = readFileSync(tracker, 'utf-8');
  ok(changed === 1 && !after.includes('John Doe') && after.includes('Jane Roe'),
    'purge --contact removes only the matching contact (by URL slug)');
  rmSync(dir, { recursive: true, force: true });
}

// ── purge report Contacts section ──────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'pcr-'));
  const report = join(dir, '001-acme.md');
  const body = '# 001 — Acme\n\n## Signal\n\nx\n\n## Contacts\n\n' +
    '- Jane Roe — VP Eng — https://www.linkedin.com/in/jane-roe — id:ACoAAA1\n' +
    '- Sam Lee — Head of ML — https://www.linkedin.com/in/sam-lee — id:ACoAAA2\n';
  writeFileSync(report, body);
  ok(purgeReport(report, { contact: 'ACoAAA1' }) === true, 'purgeReport --contact removes the matching line');
  const after = readFileSync(report, 'utf-8');
  ok(!after.includes('Jane Roe') && after.includes('Sam Lee'), 'only the matching contact line removed');
  // --account removes the whole section
  ok(purgeReport(report, { account: 'Acme' }) === true && !/## Contacts/.test(readFileSync(report, 'utf-8')),
    'purgeReport --account removes the whole Contacts section');
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
