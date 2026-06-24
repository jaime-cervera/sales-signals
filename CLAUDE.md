# Sales-Signals -- Claude Code

This file is the Claude Code entry point. The canonical, CLI-agnostic instructions live in
`AGENTS.md` (imported at the bottom). Only Claude-Code-specific notes belong here.

## What is Sales-Signals

Sales-Signals is a vendor-centric B2B buying-signal prospecting system: one vendor sells one
offering into **many ICPs**, and the system discovers companies showing a buying signal for each
ICP, qualifies them by account-fit, extracts the decision-maker to contact (via Unipile / LinkedIn
Sales Navigator), and tracks everything in a file-based CRM.

## Slash Commands

Both [OpenCode](https://opencode.ai) and [Gemini CLI](https://github.com/google-gemini/gemini-cli)
natively support the open agent skill standard (`agentskills.io`). Instead of registering
individual `.toml` files for every slash command, all subcommands are routed through the single
unified skill defined in `.agents/skills/career-ops/SKILL.md`.

> **Note:** the skill directory and the `/career-ops` slash command keep their upstream name —
> renaming them would break the CLI symlinks. The product is **Sales-Signals**.

Invoke the command center or any of its modes:

* `/career-ops` — show the command-center menu
* `/career-ops {company or URL}` — auto-pipeline: qualify the account
* `/career-ops [subcommand]` — run a specific mode

#### Subcommands:
* `icp` — onboard / create a new ICP (buying-signal profile)
* `scan` — scan for buying signals and discover new accounts
* `pipeline` — process pending companies from the inbox
* `qualify` — qualify a company's buying signal (account-fit score + dossier)
* `tracker` — show prospect CRM status overview
* `deep` — deep account research
* `batch` — parallel batch qualifications
* `patterns` — analyze disqualification patterns
* `followup` — update and calculate follow-ups

All `modes/*` files and prompt contexts (e.g. `GEMINI.md`) are shared across Claude Code, OpenCode,
and Gemini CLI.

## First run — onboarding

On the first message of each session, run the cold-start check (one deterministic source of truth,
shared with `doctor.mjs`):

```bash
node doctor.mjs --json
```

Output: `{"onboardingNeeded": <bool>, "missing": [...], "warnings": [...]}`. If `onboardingNeeded`
is true (any of `config/vendor.yml` / `icps/<slug>/signals.yml` / `icps/<slug>/icp.md` is missing),
enter onboarding via the `icp` mode before any other command. See AGENTS.md → First Run for the
full flow.

## Claude-Code-specific notes

- **Batch workers** use `claude -p "prompt"` in headless mode. Playwright is unavailable there;
  mark batch-mode reports `**Verification:** unconfirmed (batch mode)`.
- **Automation**: use the `/loop` or `/schedule` skill (when available) to set up a recurring
  `/career-ops scan`.

@AGENTS.md
<!-- Add anything Claude Code specific that other agents don't need -->
