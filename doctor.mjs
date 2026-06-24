#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for Sales-Signals
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const projectRoot =
  targetIdx !== -1 && argv[targetIdx + 1] ? argv[targetIdx + 1] : __dirname;
const JSON_OUT = argv.includes('--json');

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

// The browser tools (`browser_navigate` / `browser_snapshot`) that scan / pipeline /
// apply rely on are provided by the Playwright MCP server, registered through a
// project-level Claude Code config (`.mcp.json` or `.claude/settings.json`). When it
// is absent, SPA job boards silently return empty or stale content (#522) — so doctor
// surfaces it as a non-fatal warning rather than letting it fail invisibly.
const PLAYWRIGHT_MCP_WARNING = 'Playwright MCP tools not detected';

function playwrightMcpConfigured(root) {
  const configFiles = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
  for (const rel of configFiles) {
    const file = join(root, ...rel.split('/'));
    if (!existsSync(file)) continue;
    try {
      const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const server of Object.values(servers)) {
          if (JSON.stringify(server ?? '').toLowerCase().includes('playwright')) return true;
        }
      }
    } catch {
      // Malformed config — keep scanning the other locations; never crash doctor on it.
    }
  }
  return false;
}

function checkPlaywrightMcp(root) {
  if (playwrightMcpConfigured(root)) {
    return { pass: true, label: 'Playwright MCP server configured' };
  }
  return {
    warn: true,
    label: PLAYWRIGHT_MCP_WARNING,
    fix: [
      'Browser-driven JD fetching and liveness checks (scan / pipeline / apply) need the',
      'Playwright MCP server, which this project does not configure yet — SPA job boards',
      'may return empty or stale content.',
    ],
  };
}

// Active ICP for the cold-start check. The per-ICP user-layer files now live
// under icps/<slug>/ (multi-ICP refactor); the default ICP keeps the legacy
// filenames in Phase 1. CAREER_OPS_ICP selects which ICP doctor inspects.
const ICP_SLUG = process.env.CAREER_OPS_ICP || 'default';
const ICP_BASE = `icps/${ICP_SLUG}`;

// Single source of truth for the four user-layer prerequisites (the list
// AGENTS.md "First Run" documents). BOTH the human checklist (`checkPrereq`)
// and the machine-readable cold-start state (`onboardingState`) derive from
// THIS array, so they cannot drift. Paths use "/" and are split for join().
const USER_LAYER_PREREQS = [
  {
    path: 'config/vendor.yml',
    fix: [
      'Run: cp config/vendor.example.yml config/vendor.yml',
      'Then set your seller identity + Unipile account reference (.env holds the secrets)',
    ],
  },
  {
    path: `${ICP_BASE}/signals.yml`,
    fix: [
      `Create your first ICP: node bin/signals.mjs scan --icp <slug> --create-icp`,
      'or run the "icp" onboarding mode',
    ],
  },
  {
    path: `${ICP_BASE}/icp.md`,
    fix: [
      'The ICP definition (offering, firmographics, signal→need map)',
      'Created by the scaffolder / icp onboarding mode',
    ],
  },
];

function prereqPresent(root, path) {
  return existsSync(join(root, ...path.split('/')));
}

function checkPrereq({ path, fix }) {
  if (prereqPresent(projectRoot, path)) {
    return { pass: true, label: `${path} found` };
  }
  return { pass: false, label: `${path} not found`, fix };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

async function main() {
  console.log('\nSales-Signals doctor');
  console.log('====================\n');

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    checkPlaywrightMcp(projectRoot),
    ...USER_LAYER_PREREQS.map(checkPrereq),
    checkAutoDir('output'),
    checkAutoDir('reports'),
  ];

  let failures = 0;
  let warnings = 0;

  for (const result of checks) {
    const fixes = Array.isArray(result.fix) ? result.fix : result.fix ? [result.fix] : [];
    if (result.warn) {
      warnings++;
      console.log(`${yellow('⚠')} ${result.label}`);
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    } else if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    const warnNote = warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'} — see above)` : '';
    console.log(`Result: All checks passed${warnNote}. You're ready to go! Run \`claude\` (or \`opencode\`) to start.`);
    console.log('');
    console.log('Join the community: https://discord.gg/8pRpHETxa4');
    process.exit(0);
  }
}

// Single source of truth for the cold-start state: the same four user-layer
// prerequisites that AGENTS.md "First Run" lists. `--json` turns the trigger into
// a deterministic mechanism the agent runs (instead of re-deriving it from prose),
// and `--target <dir>` lets the test suite point it at a simulated virgin env.
function onboardingState(root) {
  const missing = USER_LAYER_PREREQS
    .filter(({ path }) => !prereqPresent(root, path))
    .map(({ path }) => path);
  const warnings = playwrightMcpConfigured(root) ? [] : [PLAYWRIGHT_MCP_WARNING];
  return { onboardingNeeded: missing.length > 0, missing, warnings };
}

if (JSON_OUT) {
  console.log(JSON.stringify(onboardingState(projectRoot)));
  process.exit(0);
} else {
  main().catch((err) => {
    console.error('doctor.mjs failed:', err.message);
    process.exit(1);
  });
}
