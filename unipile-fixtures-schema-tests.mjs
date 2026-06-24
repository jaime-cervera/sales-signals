#!/usr/bin/env node

/**
 * unipile-fixtures-schema-tests.mjs — schema guard for the Unipile fixtures (Unit 0.4).
 *
 * Asserts the captured/derived fixtures carry the REQUIRED canonical fields, so a
 * bad capture fails loudly here instead of every downstream "mocked" test passing
 * against a fiction. Registered in test-all.mjs scripts[].
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mapJob, mapPerson } from './lib/unipile-client.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(ROOT, 'test/fixtures/payloads/unipile', f), 'utf-8'));
const items = (j) => (Array.isArray(j.items) ? j.items : Array.isArray(j.data) ? j.data : []);

let passed = 0; let failed = 0;
function ok(c, m) { if (c) { console.log(`PASS ${m}`); passed++; } else { console.error(`FAIL ${m}`); failed++; } }

// ── Jobs fixture carries the canonical jobs fields ─────────────────────────
{
  const jobs = items(fx('jobs.json'));
  ok(jobs.length > 0, 'jobs fixture has items');
  for (const j of jobs) {
    ok(typeof j.title === 'string' && j.title, 'job item has a title');
    ok(typeof j.url === 'string' && /^https?:\/\//.test(j.url), 'job item has an http(s) url');
    const company = typeof j.company === 'string' ? j.company : j.company && j.company.name;
    ok(!!company, 'job item has a company (string or company.name)');
    ok(('posted_at' in j) || ('listed_at' in j), 'job item has a recency field (posted_at/listed_at)');
    const m = mapJob(j);
    ok(m.title && m.url && m.company, 'mapJob yields title+url+company');
    ok(Number.isFinite(m.postedAt), 'mapJob maps the recency field to a finite postedAt');
  }
}

// ── People fixtures carry the canonical people fields ──────────────────────
for (const file of ['people-classic.json', 'people-salesnav.json']) {
  const people = items(fx(file));
  ok(people.length > 0, `${file} has items`);
  for (const p of people) {
    const m = mapPerson(p);
    ok(!!m.name, `${file}: person has a name`);
    ok(!!m.title, `${file}: person has a title (headline / current role)`);
    ok(!!m.profileId, `${file}: person has a profileId (item.id)`);
    ok(!!m.linkedinUrl, `${file}: person has a linkedinUrl (public_profile_url / public_identifier / profile_url)`);
    ok(!/\/sales\/lead\//.test(m.linkedinUrl), `${file}: canonical linkedinUrl is never a /sales/lead/ URL`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
