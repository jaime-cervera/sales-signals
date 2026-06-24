#!/usr/bin/env node

/**
 * validate-icp-tests.mjs — tests for the ICP model + validator (Units 2.1, 2.2).
 *
 * Covers: the shipped example/template files validate; signals-schema.md rules
 * (positive required, no-source warning, unknown provider, duplicate warning);
 * and icp.md completeness. Registered in test-all.mjs scripts[].
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { validateSignalsConfig, validateIcpMarkdown } from './validate-signals.mjs';
import { loadProviderIds } from './validate-portals.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

const providerIds = await loadProviderIds();
const load = (rel) => yaml.load(readFileSync(join(ROOT, rel), 'utf-8'));
const validate = (cfg) => validateSignalsConfig(cfg, { providerIds });

// ── 2.1: shipped example signals.yml validates cleanly ─────────────────────
{
  const res = await validate(load('templates/signals.example.yml'));
  ok(res.errors.length === 0, `templates/signals.example.yml validates (0 errors; got ${res.errors.length})`);
}

// ── 2.1: icp.template.md has every required section ─────────────────────────
{
  const issues = validateIcpMarkdown(readFileSync(join(ROOT, 'templates/icp.template.md'), 'utf-8'));
  ok(issues.length === 0, `templates/icp.template.md has all required sections (got issues: ${issues.join('; ')})`);
}

// ── 2.1: vendor example loads & carries the unipile reference ──────────────
{
  const v = load('templates/../config/vendor.example.yml');
  ok(v && v.vendor && typeof v.vendor.offering === 'string', 'vendor.example.yml has vendor.offering');
  ok(v && v.unipile && 'sales_navigator' in v.unipile, 'vendor.example.yml has a unipile block');
}

// ── 2.2: empty title_filter.positive → rejected ────────────────────────────
{
  const res = await validate({ title_filter: { positive: [] }, search_queries: [{ name: 'x', query: 'y' }] });
  ok(res.errors.some(e => e.path === 'title_filter.positive'), 'empty title_filter.positive is rejected');
}

// ── 2.2: whitespace-only keyword flagged (not silently accepted) ───────────
{
  const res = await validate({ title_filter: { positive: ['   '] }, search_queries: [{ name: 'x', query: 'y' }] });
  ok(res.errors.some(e => e.path === 'title_filter.positive'),
    'whitespace-only positive keyword does not satisfy the non-empty requirement');
}

// ── 2.2: unknown provider on an enabled source → error ─────────────────────
{
  const res = await validate({
    title_filter: { positive: ['AI'] },
    tracked_companies: [{ name: 'Acme', provider: 'not-a-provider', careers_url: 'https://x.example', enabled: true }],
  });
  ok(res.errors.some(e => /unknown provider/.test(e.message)), 'unknown provider id is rejected');
}

// ── 2.2: job_boards entry with unknown provider → error ────────────────────
{
  const res = await validate({
    title_filter: { positive: ['AI'] },
    job_boards: [{ name: 'Unipile Jobs', provider: 'not-a-provider', url: 'https://x.example', enabled: true }],
  });
  ok(res.errors.some(e => e.path === 'job_boards[0].provider' && /unknown provider/.test(e.message)),
    'job_boards entry with an unknown provider is rejected');
}

// ── 2.2: job_boards entry with a loaded provider + valid url → ok ──────────
{
  const res = await validate({
    title_filter: { positive: ['AI'] },
    job_boards: [{ name: 'Greenhouse Board', provider: 'greenhouse', url: 'https://job-boards.greenhouse.io/x', enabled: true }],
  });
  ok(res.errors.length === 0, 'a valid job_boards entry (loaded provider + http url) is accepted');
}

// ── 2.2: duplicate enabled company → warning preserved ─────────────────────
{
  const res = await validate({
    title_filter: { positive: ['AI'] },
    tracked_companies: [
      { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme', enabled: true },
      { name: 'acme', careers_url: 'https://job-boards.greenhouse.io/acme2', enabled: true },
    ],
  });
  ok(res.warnings.some(w => /duplicate/.test(w.message)), 'duplicate enabled company name warns');
}

// ── 2.2: WebSearch-only ICP (no Unipile/tracked) is allowed (0 errors) ─────
{
  const res = await validate({
    title_filter: { positive: ['AI'] },
    search_queries: [{ name: 'q', query: 'site:example.com AI', enabled: true }],
  });
  ok(res.errors.length === 0, 'a WebSearch-only ICP (no Unipile block) is valid');
}

// ── 2.2: no discovery source → warning (not error) ─────────────────────────
{
  const res = await validate({ title_filter: { positive: ['AI'] } });
  ok(res.errors.length === 0 && res.warnings.some(w => /no discovery source/.test(w.message)),
    'filter-only ICP: 0 errors + a no-discovery-source warning');
}

// ── 2.2: icp.md missing sections → issues ──────────────────────────────────
{
  const issues = validateIcpMarkdown('# ICP: x\n\n## Offering\nwe sell things');
  ok(issues.length === 5 && issues.every(i => /missing required ICP section/.test(i)),
    'icp.md with only Offering flags the other 5 missing sections');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
