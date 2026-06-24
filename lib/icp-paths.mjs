/**
 * lib/icp-paths.mjs — ICP path-resolution layer (the multi-ICP backbone).
 *
 * Maps an ICP slug to every per-ICP file/dir path and exposes them as the
 * `CAREER_OPS_*` environment variables the existing scripts already read. This
 * is the single seam through which all multi-ICP scoping flows: the launcher
 * (`bin/signals.mjs`) resolves a slug here, applies the env, and runs a target
 * script scoped to one ICP. A bug here affects every mode, so the module is kept
 * pure (path strings only; the only I/O is listing `icps/` for existence checks
 * and error messages) and is covered exhaustively by `lib/icp-paths-tests.mjs`.
 *
 * Phase 1 keeps the LEGACY filenames (`portals.yml`, `data/applications.md`, …)
 * so the migrated `default` ICP is a byte-identical regression anchor. The
 * Phase-4 rename (`signals.yml`, `prospects.md`, `icp.md`, …) updates the
 * filename constants below — and only those.
 *
 * Design rules (from the plan, Unit 1.1):
 *   - Slug precedence: explicit arg → CAREER_OPS_ICP env → "default".
 *   - The resolver NEVER creates ICPs. An unknown slug always throws, listing
 *     the available ICPs. On-the-fly creation is an explicit, separate action
 *     in the launcher (`--create-icp`) / the `icp` onboarding mode — so a typo
 *     can never silently scaffold a junk ICP.
 *   - A slug that is not a safe kebab token (e.g. contains `/`, `\`, `..`) is
 *     rejected before any path is built — the resolver can never escape `icps/`.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

// Per-ICP relative filenames (Phase 4 — renamed + flattened layout). The
// resolver KEYS are kept (e.g. `portals`) because they map to grandfathered
// CAREER_OPS_* env names (see ENV_BY_KEY), but the FILES they point at are the
// Sales-Signals names: signals.yml / prospects.md / icp.md, all flat under
// icps/<slug>/ (no data/ subdir).
export const ICP_FILES = {
  portals: 'signals.yml',          // CAREER_OPS_PORTALS → the ICP's signal config
  tracker: 'prospects.md',         // CAREER_OPS_TRACKER → the CRM (was data/applications.md)
  trackerDb: 'prospects.db',       // CAREER_OPS_TRACKER_DB
  icp: 'icp.md',                   // the ICP definition (was modes/_profile.md); agent-read, no env
  profile: 'config/profile.yml',   // CAREER_OPS_PROFILE → per-ICP technical config (cadence)
  pipeline: 'pipeline.md',         // CAREER_OPS_PIPELINE
  scanHistory: 'scan-history.tsv', // CAREER_OPS_SCAN_HISTORY
  followups: 'follow-ups.md',      // CAREER_OPS_FOLLOWUPS
  reports: 'reports',              // CAREER_OPS_REPORTS
  output: 'output',                // CAREER_OPS_OUTPUT
  additions: 'tracker-additions',  // CAREER_OPS_ADDITIONS (was batch/tracker-additions)
};

// Resolver path-key → the CAREER_OPS_* env var the existing scripts read.
// PORTALS/TRACKER/TRACKER_DB/PROFILE/ADDITIONS are pre-existing (honoured today);
// PIPELINE/SCAN_HISTORY/REPORTS/FOLLOWUPS/OUTPUT are added in Unit 1.2.
export const ENV_BY_KEY = {
  portals: 'CAREER_OPS_PORTALS',
  tracker: 'CAREER_OPS_TRACKER',
  trackerDb: 'CAREER_OPS_TRACKER_DB',
  profile: 'CAREER_OPS_PROFILE',
  pipeline: 'CAREER_OPS_PIPELINE',
  scanHistory: 'CAREER_OPS_SCAN_HISTORY',
  followups: 'CAREER_OPS_FOLLOWUPS',
  reports: 'CAREER_OPS_REPORTS',
  output: 'CAREER_OPS_OUTPUT',
  additions: 'CAREER_OPS_ADDITIONS',
};

// A slug must be a single kebab token: lowercase alphanumerics + hyphens,
// starting with an alphanumeric. This rejects path traversal (`../foo`),
// separators (`a/b`, `a\b`), absolute paths, and empties — so a resolved path
// can never escape `<root>/icps/`.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** @param {string} slug */
export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Resolve the active ICP slug from precedence: explicit arg → env → "default".
 * @param {string} [slug]
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function resolveSlug(slug, opts = {}) {
  const env = opts.env || process.env;
  const raw = (slug ?? env.CAREER_OPS_ICP ?? 'default');
  return String(raw).trim();
}

/** Project root that holds the `icps/` tree. Defaults to CWD. */
function resolveRoot(opts = {}) {
  return opts.root ? path.resolve(opts.root) : process.cwd();
}

/** List available ICP slugs under `<root>/icps/` (dirs only). Never throws. */
export function listIcps(opts = {}) {
  const icpsDir = path.join(resolveRoot(opts), 'icps');
  if (!existsSync(icpsDir)) return [];
  try {
    return readdirSync(icpsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve an ICP slug to all per-ICP absolute paths.
 *
 * Throws on an invalid slug format (before building any path) and on an unknown
 * slug (a slug whose `icps/<slug>/` directory does not exist), listing the
 * available ICPs. Existence is required so a typo errors loudly instead of
 * operating on a path that was never set up.
 *
 * @param {string} [slug]   Explicit slug; falls back to CAREER_OPS_ICP, then "default".
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, mustExist?: boolean }} [opts]
 * @returns {{slug:string, dir:string, portals:string, tracker:string,
 *   trackerDb:string, profile:string, pipeline:string, scanHistory:string,
 *   followups:string, reports:string, output:string, additions:string, root:string}}
 */
export function resolveIcpPaths(slug, opts = {}) {
  const resolved = resolveSlug(slug, opts);
  if (!isValidSlug(resolved)) {
    throw new Error(
      `Invalid ICP slug: "${resolved}". A slug must match ${SLUG_RE} ` +
      `(lowercase letters, digits and hyphens) — no slashes, dots or path traversal.`,
    );
  }

  const root = resolveRoot(opts);
  const icpsDir = path.join(root, 'icps');
  const dir = path.join(icpsDir, resolved);
  const mustExist = opts.mustExist !== false; // default: require the ICP to exist

  if (mustExist && !(existsSync(dir) && statSync(dir).isDirectory())) {
    const available = listIcps(opts);
    const hint = available.length
      ? `Available ICPs: ${available.join(', ')}.`
      : `No ICPs found under ${icpsDir}. Create one with the "icp" onboarding mode ` +
        `or "--create-icp".`;
    throw new Error(`Unknown ICP "${resolved}". ${hint}`);
  }

  const at = (rel) => path.join(dir, rel);
  return {
    slug: resolved,
    dir,
    root,
    portals: at(ICP_FILES.portals),
    tracker: at(ICP_FILES.tracker),
    trackerDb: at(ICP_FILES.trackerDb),
    icp: at(ICP_FILES.icp),
    profile: at(ICP_FILES.profile),
    pipeline: at(ICP_FILES.pipeline),
    scanHistory: at(ICP_FILES.scanHistory),
    followups: at(ICP_FILES.followups),
    reports: at(ICP_FILES.reports),
    output: at(ICP_FILES.output),
    additions: at(ICP_FILES.additions),
  };
}

/**
 * Apply resolved paths to the environment as CAREER_OPS_* vars (plus
 * CAREER_OPS_ICP = slug). Returns the same env object for chaining. Used by the
 * launcher before it spawns the target script so the child reads scoped paths.
 *
 * @param {ReturnType<typeof resolveIcpPaths>} paths
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function applyEnv(paths, opts = {}) {
  const env = opts.env || process.env;
  for (const [key, varName] of Object.entries(ENV_BY_KEY)) {
    env[varName] = paths[key];
  }
  env.CAREER_OPS_ICP = paths.slug;
  return env;
}
