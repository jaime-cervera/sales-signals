---
name: career-ops
description: Sales-Signals command center -- discover buying signals, qualify accounts, track prospects across multiple ICPs
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[icp | scan | qualify | pipeline | batch | tracker | deep | followup | patterns]"
license: MIT
---

# Sales-Signals -- Router

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| Company name / URL (no sub-command) | **`auto-pipeline`** |
| `icp` | `icp` -- onboard / create a new ICP (buying-signal profile) |
| `qualify` | `qualify` -- qualify a company's buying signal (score + dossier) |
| `contacts` | `contacts` -- find decision-maker contact(s) for a qualified account (Unipile) |
| `scan` | `scan` |
| `pipeline` | `pipeline` |
| `batch` | `batch` |
| `tracker` | `tracker` |
| `deep` | `deep` |
| `followup` | `followup` |
| `patterns` | `patterns` |

**Auto-pipeline detection:** If `$mode` is not a known sub-command AND names a company (a company name, a careers/jobs URL, or a pasted job posting that signals hiring intent), execute `auto-pipeline` to qualify the account.

If `$mode` is not a sub-command AND doesn't look like a company/signal, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
Sales-Signals -- Command Center

Available commands:
  /career-ops icp       → Onboard / create a new ICP (buying-signal profile)
  /career-ops {company} → AUTO-PIPELINE: qualify account + score + dossier + tracker (paste name or URL)
  /career-ops scan      → Scan for buying signals and discover new accounts
  /career-ops pipeline  → Process pending companies from the inbox (pipeline.md)
  /career-ops qualify   → Qualify a company's buying signal (account-fit score + dossier)
  /career-ops contacts  → Find decision-maker contact(s) for a qualified account (Unipile)
  /career-ops batch     → Batch processing with parallel workers
  /career-ops tracker   → Prospect CRM status overview
  /career-ops deep      → Deep account-research prompt about a company
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops patterns  → Analyze disqualification patterns and improve targeting

Inbox: add companies/URLs to the active ICP's pipeline.md → /career-ops pipeline
Or paste a company name/URL directly to qualify the account.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `qualify`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `icp`, `contacts`, `tracker`, `deep`, `patterns`, `followup`

### Multi-ICP awareness (Sales-Signals)

Every data-touching mode operates on the **active ICP**. The active ICP is set by
the host launcher `bin/signals.mjs <mode> --icp <slug>` (or `CAREER_OPS_ICP`), which
resolves all per-ICP paths via `lib/icp-paths.mjs` before running. Operating on one
ICP must never read or write another's files. To create a new ICP, use the `icp`
mode or `bin/signals.mjs <mode> --icp <slug> --create-icp`.

### Modes delegated to subagent:
For `scan` and `pipeline` (3+ companies): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="sales-signals {mode}"
)
```

Execute the instructions from the loaded mode file.
