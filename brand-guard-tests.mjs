#!/usr/bin/env node

/**
 * brand-guard-tests.mjs — Old-product-name guard (Units 7.2/7.5)
 *
 * Fails if any KEPT, shipped text file still carries the OLD product brand
 * (`career-ops` / `careerops` / "AI job search" / "job search" / job-seeker
 * branding) in code, identifiers, or shipped docs. This makes the Sales-Signals
 * rebrand's completeness mechanically enforceable: a guard catches stale
 * branding that a human reviewer would miss across a wide surface.
 *
 * Standalone assertion script (repo convention): Node built-ins only, no test
 * framework. Registered in test-all.mjs `scripts[]` so it gates in CI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY ALLOWED (NOT branding — kept on purpose):
 *
 *   1. `CAREER_OPS_*` env identifiers (incl. CAREER_OPS_ICP) — grandfathered.
 *      Renaming the env vars is churn with migration risk and no user value.
 *   2. The skill directory path `.agents/skills/career-ops/` and its CLI mirror
 *      paths (`.claude/`, `.opencode/`, `.qwen/`) — renaming the dir would break
 *      the skill symlinks.
 *   3. The `/career-ops` slash command (and `/career-ops-scan`) — the user-facing
 *      command keeps the skill's name (same reason as #2).
 *   4. The SKILL.md frontmatter `name: career-ops` — the skill identity must match
 *      its directory name.
 *   5. A backtick-wrapped `` `career-ops` `` reference — used in README/CLAUDE to
 *      EXPLAIN that the slash command / skill dir keep the upstream name.
 *   6. The Go module path `github.com/santifer/career-ops/dashboard` — the whole
 *      `dashboard/` tree is excluded (renaming the module path is pure churn).
 *
 * EXCLUDED FILES/DIRS (not scanned):
 *   - This guard + the sibling guards/test harness (they describe the removed
 *     surface by name: brand-guard-tests.mjs, dangling-ref-tests.mjs, test-all.mjs).
 *   - The plan/gate/spike records under docs/plans, docs/testing, docs/spikes
 *     (historical; they intentionally name the old product).
 *   - CHANGELOG.md (historical upstream release notes; provenance kept).
 *   - The Go dashboard tree (module path kept) and generated/vendored trees.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); passed++; };

// ── Old-brand patterns (case-insensitive). Each must NOT appear in a kept file
// except in an allowed context (see stripAllowed below).
const BRAND_PATTERNS = [
  /career-?ops/i,        // career-ops, careerops, career_ops
  /\bAI job search\b/i,
  /\bjob search\b/i,
  /\bjob-search\b/i,
  /\bjob seeker\b/i,
  /\bjob-seeker\b/i,
];

const EXCLUDED_FILES = new Set([
  'brand-guard-tests.mjs',
  'dangling-ref-tests.mjs',
  'test-all.mjs',
  'CHANGELOG.md',
]);
const EXCLUDED_DIR_PREFIXES = [
  '.git', 'node_modules',
  'dashboard',                 // Go module path github.com/santifer/career-ops kept
  'docs/plans', 'docs/testing', 'docs/spikes',
];

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.yml', '.yaml', '.json', '.sh', '.toml', '.txt', '.cff', '.go', '.nix',
]);
const EXTRA_FILES = new Set(['Dockerfile', 'cops']); // no-extension shipped text

function isExcludedDir(rel) {
  const norm = rel.split(sep).join('/');
  return EXCLUDED_DIR_PREFIXES.some((p) => norm === p || norm.startsWith(p + '/'));
}

function shouldScan(rel) {
  const norm = rel.split(sep).join('/');
  if (EXCLUDED_FILES.has(norm)) return false;
  const base = norm.split('/').pop();
  if (EXCLUDED_FILES.has(base)) return false;
  if (EXTRA_FILES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  return TEXT_EXT.has(ext);
}

/**
 * Remove all DELIBERATELY-ALLOWED occurrences of the old name from a line before
 * pattern-matching, so only genuine stray branding can trip the guard.
 */
function stripAllowed(line) {
  return line
    // 1. CAREER_OPS_* env identifiers (grandfathered).
    .replace(/CAREER_OPS_[A-Z0-9_]*/g, '')
    // 2. skill dir paths under any CLI mirror: .agents/.claude/.opencode/.qwen
    .replace(/skills[/\\]career-ops/gi, '')
    // 3. /career-ops slash command (and /career-ops-scan style variants)
    .replace(/\/career-ops[\w-]*/gi, '')
    // 4. SKILL.md frontmatter `name: career-ops`
    .replace(/name:\s*career-ops/gi, '')
    // 5. backtick-wrapped explanatory reference `career-ops`
    .replace(/`career-ops`/gi, '')
    // 6. Go module path (defensive; the whole dashboard/ tree is also excluded)
    .replace(/github\.com\/santifer\/career-ops/gi, '');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (isExcludedDir(rel)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && shouldScan(rel)) out.push(rel);
  }
  return out;
}

console.log('\n🏷  brand guard (old product name: career-ops / AI job search)\n');

const files = walk(ROOT, []);
const offenders = [];

for (const rel of files) {
  let text;
  try { text = readFileSync(join(ROOT, rel), 'utf-8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripAllowed(lines[i]);
    for (const pat of BRAND_PATTERNS) {
      const m = stripped.match(pat);
      if (m) {
        offenders.push({
          file: rel.split(sep).join('/'),
          line: i + 1,
          hit: m[0],
          text: lines[i].trim().slice(0, 120),
        });
        break; // one offense per line is enough
      }
    }
  }
}

if (offenders.length === 0) {
  pass(`No old-product branding in kept shipped files (${files.length} files scanned)`);
} else {
  for (const o of offenders) {
    fail(`${o.file}:${o.line} carries old brand "${o.hit}"  →  ${o.text}`);
  }
}

// Sanity: the guard must actually be scanning a meaningful surface (catches an
// accidental over-broad exclusion that would make the guard pass vacuously).
if (files.length >= 30) {
  pass(`Guard scanned a meaningful file surface (${files.length} files)`);
} else {
  fail(`Guard scanned too few files (${files.length}) — exclusions may be too broad`);
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
