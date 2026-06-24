#!/usr/bin/env node

/**
 * dangling-ref-tests.mjs — Dangling-reference guard (Unit 7.1)
 *
 * Fails if any KEPT, shipped text file still references a job-seeker-only
 * artifact that Unit 7.1 removed (CV/PDF/LaTeX/cover/interview/training/project/
 * apply/i18n/updater/gemini surface). The mode-file dangling-ref guard catches
 * stale *references*; the test-all "Mode file integrity" check catches orphaned
 * mode *files*; together they keep the removal complete.
 *
 * Standalone assertion script (repo convention): Node built-ins only, no test
 * framework. Registered in test-all.mjs `scripts[]` so it gates in CI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COVERAGE REMOVAL LEDGER (Unit 7.1, per R6 — out-of-scope job-seeker surface)
 *
 * test-all.mjs assertions/sections DELETED as out-of-scope (justified per R6):
 *   - scripts[] entries:  cv-sync-check.mjs (was the lone `allowFail` warning),
 *     updater-migration-tests.mjs, update-system.mjs check.
 *   - Section 7b  "PDF render wait condition"        (generate-pdf.mjs)            — 2 asserts
 *   - Section 7c  "Updater dashboard rebuild"        (update-system.mjs)           — 1 assert
 *   - Section 16  "update-system SEMVER_RE"          (update-system.mjs)           — 3 asserts
 *   - Section 17  "Cover letter greeting block"      (generate-cover-letter.mjs)   — 3 asserts
 *   - Section 18  "Cover letter single-pass subst."  (generate-cover-letter.mjs)   — 2 asserts
 *   - Section 19  "Font inlining (#951)"             (generate-pdf.mjs + fonts/)   — 4 asserts
 *   - Section 20  "LaTeX validator i18n"             (generate-latex.mjs)          — 3 asserts
 *   - Section 21  "CJK CV rendering"                 (cv-template.html)            — 2 asserts
 *   - Section 8   expectedModes list                 (removed modes dropped)
 *   - Section 8   SKILL menu `/career-ops latex`     (replaced w/ focused-menu +
 *                                                     removed-mode absence checks)
 *   - Section 8   apply-mode preflight gate          (modes/apply.md removed)      — 1 assert
 *   - Section 8   oferta liveness gate               (modes/oferta.md removed; the
 *                                                     auto-pipeline half is kept)
 *   - Section 5   systemFiles: cv-template.html, modes/_profile.template.md,
 *                 modes/oferta.md, modes/pdf.md  (replaced w/ kept files)
 *   - Section 11  AGENTS.md requiredSections: "Update Check" removed (its content
 *                 was deleted from AGENTS.md/CLAUDE.md).
 *
 * NET: the post-strip suite has a lower assertion count by design; the drop is the
 * sum of the lines above and is intentional, not a silent regression. Unit 7.5
 * compares the final named-check list against baseline minus this ledger.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); passed++; };

// ── Removed artifacts (Unit 7.1). Each pattern is a literal substring that must
// NOT appear in any kept shipped text file. Grouped only for readability.
const REMOVED_PATTERNS = [
  // Removed scripts (basenames)
  'generate-pdf.mjs', 'generate-latex.mjs', 'build-cv-latex.mjs',
  'generate-cover-letter.mjs', 'cv-sync-check.mjs', 'update-system.mjs',
  'updater-migration-tests.mjs', 'gemini-eval.mjs',
  // Removed templates / assets
  'cv-template.html', 'cv-template.tex', 'cover-letter-template.html',
  // Removed modes
  'modes/pdf.md', 'modes/latex.md', 'modes/cover.md', 'modes/interview.md',
  'modes/interview-prep.md', 'modes/training.md', 'modes/project.md',
  'modes/apply.md', 'modes/ofertas.md', 'modes/oferta.md', 'modes/update.md',
  'modes/contacto.md', 'modes/_profile.template.md', '_profile.template',
  // Removed i18n mode dirs
  'modes/de/', 'modes/fr/', 'modes/ja/', 'modes/tr/', 'modes/ar/',
  'modes/pt/', 'modes/ru/', 'modes/ua/',
  // Removed dirs
  'fonts/', 'interview-prep/', 'writing-samples/', 'jds/',
  // Removed dependency / npm scripts
  '@google/generative-ai', 'gemini:eval',
];

// ── Files/dirs the guard does NOT scan.
//   - The guards/test harness themselves (they name the removed surface).
//   - The plan doc and the gate/baseline records (historical, intentionally name
//     the removed surface).  CHANGELOG.md (historical release notes).
//   - Generated/vendored trees and git internals.
// Units 7.2–7.4 have now rebranded/removed the surface that was previously
// excluded here (translated READMEs, examples/, DOCKER.md, CONTRIBUTING.md,
// CONTRIBUTORS.md, docs/* content), so those exclusions are removed and the guard
// now scans them — keeping it meaningful.
const EXCLUDED_FILES = new Set([
  'dangling-ref-tests.mjs',
  'brand-guard-tests.mjs',
  'test-all.mjs', // negative-assertion test data names removed modes (REMOVED_SKILL_MENU)
  'CHANGELOG.md',
]);
const EXCLUDED_DIR_PREFIXES = [
  '.git', 'node_modules', 'dashboard', // Go dashboard is out of scope (constraint)
  'docs/plans', 'docs/testing', 'docs/spikes', // historical records
];
// Translated READMEs (Unit 7.4 removes them). Match README.<lang>.md, keep README.md.
const I18N_README_RE = /^README\.[\w-]+\.md$/;

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.yml', '.yaml', '.json', '.sh', '.toml', '.txt', '.cff',
]);
const EXTRA_FILES = new Set(['Dockerfile', 'cops']); // no-extension shipped text

function isExcludedDir(rel) {
  const norm = rel.split(sep).join('/');
  return EXCLUDED_DIR_PREFIXES.some(
    (p) => norm === p || norm.startsWith(p + '/')
  );
}

function shouldScan(rel) {
  const norm = rel.split(sep).join('/');
  if (EXCLUDED_FILES.has(norm)) return false;
  if (I18N_README_RE.test(norm)) return false;
  const base = norm.split('/').pop();
  if (EXTRA_FILES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  return TEXT_EXT.has(ext);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (isExcludedDir(rel)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && shouldScan(rel)) {
      out.push(rel);
    }
  }
  return out;
}

console.log('\n🛡  dangling-reference guard (removed job-seeker surface)\n');

const files = walk(ROOT, []);
const offenders = [];

for (const rel of files) {
  let text;
  try { text = readFileSync(join(ROOT, rel), 'utf-8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pat of REMOVED_PATTERNS) {
      if (lines[i].includes(pat)) {
        offenders.push({ file: rel.split(sep).join('/'), line: i + 1, pat, text: lines[i].trim().slice(0, 120) });
      }
    }
  }
}

if (offenders.length === 0) {
  pass(`No dangling references to removed surface (${files.length} files scanned)`);
} else {
  for (const o of offenders) {
    fail(`${o.file}:${o.line} references removed "${o.pat}"  →  ${o.text}`);
  }
}

// Sanity: the removed files/dirs really are gone (so the guard is meaningful).
const MUST_BE_ABSENT = [
  'generate-pdf.mjs', 'generate-latex.mjs', 'build-cv-latex.mjs',
  'generate-cover-letter.mjs', 'cv-sync-check.mjs', 'update-system.mjs',
  'updater-migration-tests.mjs', 'gemini-eval.mjs',
  'templates/cv-template.html', 'templates/cv-template.tex',
  'templates/cover-letter-template.html', 'modes/_profile.template.md',
  'modes/pdf.md', 'modes/oferta.md', 'modes/apply.md', 'modes/contacto.md',
  'fonts', 'interview-prep', 'writing-samples', 'jds',
  'modes/de', 'modes/fr', 'modes/ja', 'modes/ar', 'modes/tr', 'modes/pt',
  'modes/ru', 'modes/ua',
];
const stillPresent = MUST_BE_ABSENT.filter((p) => existsSync(join(ROOT, p)));
if (stillPresent.length === 0) {
  pass('All removed files/dirs are absent from the tree');
} else {
  fail(`Removed artifacts still present on disk: ${stillPresent.join(', ')}`);
}

console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
