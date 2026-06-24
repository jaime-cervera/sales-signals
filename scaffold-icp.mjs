#!/usr/bin/env node

/**
 * scaffold-icp.mjs — materialize a new ICP directory from templates.
 *
 *   node scaffold-icp.mjs --slug <slug> [--force] [--root <dir>]
 *
 * Creates icps/<slug>/ ready to use immediately (`bin/signals.mjs verify --icp
 * <slug>` works the moment it returns). It is the deterministic half of ICP
 * creation; the conversational `icp` onboarding mode (modes/icp.md) drives the
 * capture and then fills in the scaffolded files.
 *
 * TRANSITION NOTE: Phase 2 writes the LEGACY filenames the resolver currently
 * maps to (portals.yml / config/profile.yml / modes/_profile.md / data/*), so a
 * new ICP is usable with today's scripts. The CONTENT, however, is already the
 * new ICP model (sourced from templates/signals.example.yml + icp.template.md).
 * Unit 4.3 renames + flattens these for ALL ICPs (default included) in lockstep.
 */

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, statSync,
} from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isValidSlug } from './lib/icp-paths.mjs';

const SCRIPTS_ROOT = path.dirname(fileURLToPath(import.meta.url));

const CRM_TRACKER_HEADER =
  '# Prospects Tracker\n\n' +
  '| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |\n' +
  '|---------|--------|------------|----------|--------|---------|--------|-------|\n';

const PIPELINE_SCAFFOLD = '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
const SCAN_HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n';

const MINIMAL_PROFILE = (slug) =>
  `# ICP profile for "${slug}" (placeholder — the icp onboarding mode fills this in).\n` +
  'candidate:\n' +
  `  full_name: "${slug} vendor"\n` +
  '  email: "you@example.com"\n' +
  '  location: "Remote"\n' +
  'target_roles:\n' +
  '  primary:\n' +
  '    - "<signal role>"\n';

/**
 * Normalize a raw name into a safe kebab slug (spaces/caps → kebab; unsafe chars
 * dropped). Throws if nothing valid remains.
 * @param {string} raw
 */
export function normalizeSlug(raw) {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alnum runs → single hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens
  if (!isValidSlug(slug)) {
    throw new Error(`Cannot derive a valid ICP slug from "${raw}".`);
  }
  return slug;
}

/**
 * Scaffold icps/<slug>/ from templates. Returns the created paths.
 * @param {{ slug: string, root?: string, force?: boolean }} opts
 */
export function scaffoldIcp({ slug, root = process.cwd(), force = false }) {
  const normalized = normalizeSlug(slug);
  const base = path.join(root, 'icps', normalized);

  if (existsSync(base) && statSync(base).isDirectory() && !force) {
    throw new Error(`ICP "${normalized}" already exists at ${base}. Use --force to overwrite.`);
  }

  // Source content from the locked ICP templates (new schema), written under the
  // legacy filenames the resolver currently maps to.
  const signalsExample = readFileSync(path.join(SCRIPTS_ROOT, 'templates', 'signals.example.yml'), 'utf-8');
  const icpTemplate = readFileSync(path.join(SCRIPTS_ROOT, 'templates', 'icp.template.md'), 'utf-8')
    .replace(/\{\{ICP_NAME\}\}/g, normalized);

  for (const d of ['config', 'reports', 'tracker-additions']) {
    mkdirSync(path.join(base, d), { recursive: true });
  }

  // Flat Sales-Signals layout (Phase 4): signals.yml / icp.md / prospects.md,
  // all directly under icps/<slug>/ (no data/ subdir).
  const files = {
    'signals.yml': signalsExample,
    'icp.md': icpTemplate,
    'config/profile.yml': MINIMAL_PROFILE(normalized),
    'prospects.md': CRM_TRACKER_HEADER,
    'pipeline.md': PIPELINE_SCAFFOLD,
    'scan-history.tsv': SCAN_HISTORY_HEADER,
    'reports/.gitkeep': '',
    'tracker-additions/.gitkeep': '',
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(base, ...rel.split('/')), content);
  }

  return { slug: normalized, dir: base };
}

function parseArgs(argv) {
  let slug;
  let root;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') slug = argv[++i];
    else if (a.startsWith('--slug=')) slug = a.slice('--slug='.length);
    else if (a === '--root') root = argv[++i];
    else if (a === '--force') force = true;
  }
  return { slug, root, force };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { slug, root, force } = parseArgs(process.argv.slice(2));
  if (!slug) {
    console.error('Usage: node scaffold-icp.mjs --slug <slug> [--force] [--root <dir>]');
    process.exit(1);
  }
  try {
    const res = scaffoldIcp({ slug, root: root || process.cwd(), force });
    console.log(`Created ICP "${res.slug}" at ${res.dir}`);
    console.log('Next: edit its signals.yml (buying-signal roles) + icp.md (ICP definition), then run');
    console.log(`  node bin/signals.mjs scan --icp ${res.slug}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
