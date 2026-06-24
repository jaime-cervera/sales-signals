#!/usr/bin/env node

/**
 * bin/signals.mjs — host-side ICP-scoping launcher (the central seam for
 * multi-ICP scoping; NOT `cops`, which is only an optional Docker passthrough).
 *
 *   node bin/signals.mjs <command> [--icp <slug>] [args...]
 *
 * It resolves the active ICP via lib/icp-paths.mjs, applies the CAREER_OPS_*
 * env the existing scripts already read, and runs the target script ON THE HOST
 * scoped to that one ICP. The scripts + templates/ + providers/ always live at
 * the launcher's own project root (so e.g. tracker.mjs finds templates/states.yml),
 * while the `icps/` DATA root is overridable via CAREER_OPS_ROOT — that lets the
 * isolation tests run the real launcher against a throwaway ICP tree.
 *
 * Phase 1 ships ONLY `--icp` resolution + env scoping. On-the-fly creation
 * (`--create-icp`) and the `icp` onboarding mode arrive in Phase 2 (Unit 2.3);
 * until then `--create-icp` errors clearly rather than scaffolding silently.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { resolveIcpPaths, applyEnv, listIcps } from '../lib/icp-paths.mjs';
import { scaffoldIcp, normalizeSlug } from '../scaffold-icp.mjs';

// Where the scripts/templates/providers live (the launcher's project root).
const SCRIPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where the `icps/` data tree lives. Defaults to SCRIPTS_ROOT; CAREER_OPS_ROOT
// overrides it (used by tests to point at an isolated fixture tree).
const DATA_ROOT = process.env.CAREER_OPS_ROOT
  ? path.resolve(process.env.CAREER_OPS_ROOT)
  : SCRIPTS_ROOT;

// command → script (relative to SCRIPTS_ROOT). Phases 2-5 extend this map
// (validate-signals, scaffold-icp, aggregate-signals, find-contacts, …).
const COMMANDS = {
  doctor: 'doctor.mjs',
  verify: 'verify-pipeline.mjs',
  normalize: 'normalize-statuses.mjs',
  dedup: 'dedup-tracker.mjs',
  merge: 'merge-tracker.mjs',
  scan: 'scan.mjs',
  'scan:full': 'scan-ats-full.mjs',
  'validate:portals': 'validate-portals.mjs',
  validate: 'validate-signals.mjs',
  tracker: 'tracker.mjs',
  patterns: 'analyze-patterns.mjs',
  followup: 'followup-cadence.mjs',
  contacts: 'find-contacts.mjs',
  'purge-contacts': 'purge-contacts.mjs',
  liveness: 'check-liveness.mjs',
  'reserve-report': 'reserve-report-num.mjs',
};

function parseArgs(argv) {
  let icp;
  let createIcp = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--icp') icp = argv[++i];
    else if (a.startsWith('--icp=')) icp = a.slice('--icp='.length);
    else if (a === '--create-icp') createIcp = true;
    else rest.push(a);
  }
  return { icp, createIcp, rest };
}

function listAvailable() {
  const l = listIcps({ root: DATA_ROOT });
  return l.length ? l.join(', ') : '(none — run the "icp" onboarding mode)';
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function printHelp() {
  console.log('Usage: node bin/signals.mjs <command> [--icp <slug>] [args]');
  console.log(`Commands: ${Object.keys(COMMANDS).join(', ')}`);
  console.log(`ICPs: ${listAvailable()}`);
}

const { icp, createIcp, rest } = parseArgs(process.argv.slice(2));
const command = rest.shift();

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(command ? 0 : 1);
}

const script = COMMANDS[command];
if (!script) {
  die(`Unknown command "${command}". Known commands: ${Object.keys(COMMANDS).join(', ')}`);
}

// On-the-fly creation: --create-icp scaffolds the slug BEFORE resolving, so a
// brand-new ICP can be created and used in one shot. Without it, an unknown slug
// still errors (a typo can never silently scaffold a junk ICP — Unit 2.3).
let effectiveSlug = icp;
if (createIcp) {
  if (!icp) die('--create-icp requires --icp <slug>.');
  try {
    const res = scaffoldIcp({ slug: icp, root: DATA_ROOT });
    effectiveSlug = res.slug;
    console.error(`Created ICP "${res.slug}".`);
  } catch (e) {
    // Already-exists is fine — fall through and run against it. Anything else aborts.
    if (!/already exists/.test(e.message)) die(e.message);
    // The raw --icp may be a non-kebab name (e.g. "Mixed Case"); resolveIcpPaths
    // only accepts the normalized slug, so normalize it the same way scaffoldIcp
    // did when the ICP was first created.
    effectiveSlug = normalizeSlug(icp);
  }
}

let paths;
try {
  // Pure resolver: unknown slug throws (listing available) — never scaffolds.
  paths = resolveIcpPaths(effectiveSlug, { root: DATA_ROOT });
} catch (e) {
  die(e.message);
}

const env = applyEnv(paths, { env: { ...process.env } });
// cwd = SCRIPTS_ROOT so CWD-relative reads (e.g. tracker.mjs's templates/states.yml)
// resolve against the real project; the scoped CAREER_OPS_* paths are absolute.
const res = spawnSync(process.execPath, [path.join(SCRIPTS_ROOT, script), ...rest], {
  cwd: SCRIPTS_ROOT,
  env,
  stdio: 'inherit',
});
if (res.error) die(`Failed to run ${script}: ${res.error.message}`);
process.exit(res.status ?? 1);
