#!/usr/bin/env node

/**
 * validate-signals.mjs — validator for a per-ICP `signals.yml` (+ optional
 * `icp.md`). Reuses the proven `validate-portals.mjs` shape checks
 * (the signals shape is a superset) and layers the signals-schema.md rules on
 * top: `title_filter.positive` is REQUIRED non-empty, and a missing discovery
 * source is warned.
 *
 * Usage:
 *   node validate-signals.mjs --file icps/<slug>/signals.yml
 *   node validate-signals.mjs --file <signals.yml> --icp-file <icp.md>
 *   node validate-signals.mjs --self-test
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { validatePortalsConfig, loadProviderIds } from './validate-portals.mjs';

// Required ## sections in an icp.md (parallels templates/icp.template.md).
const REQUIRED_ICP_SECTIONS = [
  'Offering',
  'Value Proposition',
  'Firmographics',
  'Buying Signals',      // "## Buying Signals → Need Mapping"
  'Decision-Makers',
  'Disqualifiers',
];

/**
 * Validate a parsed signals.yml object against signals-schema.md.
 * @returns {Promise<{errors: {path:string,message:string}[], warnings: {path:string,message:string}[]}>}
 */
export async function validateSignalsConfig(config, { providerIds = new Set() } = {}) {
  const { errors, warnings } = await validatePortalsConfig(config, { providerIds });

  // Rule 2: title_filter.positive REQUIRED non-empty (an ICP with no signal
  // keyword is useless). validatePortalsConfig treats it as optional.
  const positives = config && config.title_filter ? config.title_filter.positive : undefined;
  const nonEmptyPositives = Array.isArray(positives)
    ? positives.filter(s => typeof s === 'string' && s.trim() !== '')
    : [];
  if (nonEmptyPositives.length === 0) {
    errors.push({
      path: 'title_filter.positive',
      message: 'must be a non-empty list of signal-role keywords',
    });
  }

  // Rule 6: at least one discovery source SHOULD exist (warning, not error).
  const has = (k) => Array.isArray(config && config[k]) && config[k].length > 0;
  if (!has('tracked_companies') && !has('job_boards') && !has('search_queries')) {
    warnings.push({
      path: '<root>',
      message: 'no discovery source configured (tracked_companies / job_boards / search_queries)',
    });
  }

  return { errors, warnings };
}

/** Validate an icp.md for required sections. Returns an array of issue strings. */
export function validateIcpMarkdown(text) {
  const issues = [];
  if (typeof text !== 'string' || text.trim() === '') {
    issues.push('icp.md is empty');
    return issues;
  }
  for (const section of REQUIRED_ICP_SECTIONS) {
    // Match a markdown heading line containing the section label.
    const re = new RegExp(`^#{1,6}\\s.*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'mi');
    if (!re.test(text)) issues.push(`missing required ICP section: "${section}"`);
  }
  return issues;
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFiles({ signalsPath, icpPath }) {
  const out = { errors: [], warnings: [], icpIssues: [] };
  if (signalsPath) {
    if (!existsSync(signalsPath)) throw new Error(`file not found: ${signalsPath}`);
    const providerIds = await loadProviderIds();
    const parsed = yaml.load(readFileSync(signalsPath, 'utf-8'));
    const { errors, warnings } = await validateSignalsConfig(parsed, { providerIds });
    out.errors = errors;
    out.warnings = warnings;
  }
  if (icpPath) {
    if (!existsSync(icpPath)) throw new Error(`file not found: ${icpPath}`);
    out.icpIssues = validateIcpMarkdown(readFileSync(icpPath, 'utf-8'));
  }
  return out;
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'sales-signals-validate-self-test-'));
  try {
    // Missing positive keywords → 1 signals error; empty icp.md → all sections missing.
    const bad = join(tmp, 'bad.yml');
    writeFileSync(bad, 'title_filter:\n  positive: []\ntracked_companies: []\n', 'utf-8');
    const res = await validateFiles({ signalsPath: bad });
    if (!res.errors.some(e => e.path === 'title_filter.positive')) {
      throw new Error('expected a title_filter.positive error for empty positives');
    }
    if (!res.warnings.some(w => /no discovery source/.test(w.message))) {
      throw new Error('expected a no-discovery-source warning');
    }
    const icpIssues = validateIcpMarkdown('# ICP: x\n\nnothing here');
    if (icpIssues.length !== REQUIRED_ICP_SECTIONS.length) {
      throw new Error(`expected ${REQUIRED_ICP_SECTIONS.length} icp issues, got ${icpIssues.length}`);
    }
    console.log('validate-signals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }
  const fileFlag = args.indexOf('--file');
  const icpFlag = args.indexOf('--icp-file');
  const signalsPath = fileFlag === -1
    ? resolve(process.env.CAREER_OPS_PORTALS || 'signals.yml')
    : resolve(args[fileFlag + 1] || '');
  const icpPath = icpFlag === -1 ? null : resolve(args[icpFlag + 1] || '');

  let result;
  try {
    result = await validateFiles({ signalsPath, icpPath });
  } catch (err) {
    console.error(`validate-signals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-signals: ${signalsPath}`);
  for (const w of result.warnings) console.log(`warning: ${formatIssue(w)}`);
  for (const e of result.errors) console.log(`error: ${formatIssue(e)}`);
  for (const i of result.icpIssues) console.log(`error: icp.md: ${i}`);
  const errorCount = result.errors.length + result.icpIssues.length;
  console.log(`${errorCount} errors, ${result.warnings.length} warnings`);
  if (errorCount > 0) process.exit(1);
}

// Run main() only when invoked directly — importing this module (the test
// suites use validateSignalsConfig / validateIcpMarkdown) must be side-effect-free.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`validate-signals failed: ${err.message}`);
    process.exit(1);
  });
}
