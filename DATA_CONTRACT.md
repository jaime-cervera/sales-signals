# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates). Sales-Signals is **multi-ICP**: every piece of user data lives under `icps/<slug>/` and is isolated per ICP.

## User Layer (NEVER auto-updated)

These files contain your seller identity, ICP definitions, prospect data, and work product. Updates will NEVER modify them. All per-ICP user data is gitignored (it holds prospect/contact PII).

| File | Purpose |
|------|---------|
| `config/vendor.yml` | The one seller identity + Unipile account reference |
| `.env` | Unipile secrets (`UNIPILE_API_KEY`, `UNIPILE_DSN`, `UNIPILE_ACCOUNT_ID`) — gitignored |

### Per-ICP User Layer (multi-ICP)

Each ICP's user data is isolated under `icps/<slug>/` and is also User Layer — never auto-updated, never committed (gitignored). The launcher `bin/signals.mjs --icp <slug>` scopes every script to one ICP via `lib/icp-paths.mjs`. Operating on one ICP never reads or writes another's files.

| File (per ICP) | Purpose |
|----------------|---------|
| `icps/<slug>/icp.md` | This ICP's definition (offering, value prop, firmographics, signal→need mapping) |
| `icps/<slug>/signals.yml` | This ICP's buying-signal role queries + title/location filters |
| `icps/<slug>/config/profile.yml` | This ICP's technical config (e.g. follow-up cadence) |
| `icps/<slug>/prospects.md` | This ICP's CRM tracker — one row per account, append-only |
| `icps/<slug>/prospects.db` | Derived query index over the tracker (SQLite, rebuilt by `node tracker.mjs sync` — safe to delete) |
| `icps/<slug>/pipeline.md` | This ICP's detected-signal inbox |
| `icps/<slug>/scan-history.tsv` | This ICP's scanner dedup history |
| `icps/<slug>/data/follow-ups.md` | This ICP's follow-up history |
| `icps/<slug>/reports/*` | This ICP's account dossiers |

`config/vendor.yml` is also User Layer (the one **seller** identity + Unipile account reference; the secrets live in `.env`).

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Account-fit scoring system, global rules, tools |
| `modes/icp.md` | ICP onboarding instructions |
| `modes/scan.md` | Buying-signal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/qualify.md` | Account qualification instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/deep.md` | Account-research prompt instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/tracker.md` | CRM view instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `CLAUDE.md` | Agent instructions (Claude Code) |
| `OPENCODE.md` | Agent instructions (OpenCode) |
| `AGENTS.md` | Canonical agent instructions (imported by CLI-specific wrappers) |
| `bin/signals.mjs`, `lib/*`, `providers/*`, `*.mjs` | Launcher, path resolver, discovery providers, utility scripts |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates (incl. `crm-schema.md`, `signals-schema.md`, `states.yml`) |
| `.claude/skills/*` | Skill definitions (Claude Code) |
| `.opencode/skills/*` | Skill definitions (OpenCode) |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## Grandfathered environment-variable names

The launcher exports per-ICP paths as a set of `CAREER_OPS_*` environment variables — `CAREER_OPS_ICP`, `CAREER_OPS_TRACKER`, `CAREER_OPS_PORTALS`, `CAREER_OPS_PROFILE`, `CAREER_OPS_PIPELINE`, `CAREER_OPS_SCAN_HISTORY`, `CAREER_OPS_REPORTS`, `CAREER_OPS_FOLLOWUPS`, etc. — which the underlying scripts read.

**These names are kept from the upstream project on purpose.** Renaming them is churn with migration risk and no user value, so they remain `CAREER_OPS_*` even though the product is Sales-Signals. They are the one deliberate exception to the rebrand.

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
