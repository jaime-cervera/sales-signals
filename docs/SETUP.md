# Setup Guide

## Prerequisites

- An AI coding CLI — [Claude Code](https://claude.com/claude-code), Gemini CLI, Codex, Qwen Code, or OpenCode
- [Node.js](https://nodejs.org) 22.5+ and `git`
- A [Unipile](https://www.unipile.com) account with a connected LinkedIn account (Sales Navigator
  for decision-maker contacts) — the primary discovery + contact engine
- (Optional) Go 1.21+ for the dashboard TUI

## Install

```bash
git clone <your-fork-url> sales-signals
cd sales-signals
npm install
npx playwright install chromium   # only needed for liveness verification
```

## Configure

```bash
# 1. Unipile secrets (gitignored)
cp .env.example .env
#    set UNIPILE_API_KEY / UNIPILE_DSN / UNIPILE_ACCOUNT_ID

# 2. Seller identity
cp config/vendor.example.yml config/vendor.yml
#    set your company, offering, default geography, Unipile account_ref

# 3. Check setup
npm run doctor                     # validates prerequisites + cold-start onboarding
```

## First run — onboard your first ICP

Open your AI CLI in the folder:

```bash
claude   # or gemini / codex / qwen / opencode
```

**On first launch, Sales-Signals walks you through onboarding by chatting** — it captures your
offering, the firmographics you target, and the buying-signal roles that imply a need, then
scaffolds your first ICP under `icps/<slug>/`. Nothing to edit by hand: just answer its questions.

You can also create an ICP non-interactively:

```bash
node scaffold-icp.mjs --slug acme
# then edit icps/acme/icp.md and icps/acme/signals.yml
node bin/signals.mjs scan --icp acme           # discover buying signals
```

## Active-ICP scoping

Every data-touching command runs through the launcher, scoped to one ICP:

```bash
node bin/signals.mjs scan --icp acme
node bin/signals.mjs qualify --icp acme Stripe
node bin/signals.mjs scan --icp newslug --create-icp   # create on the fly
```

## Common commands

| Action | How |
|--------|-----|
| Onboard / create an ICP | `/career-ops icp` or `--create-icp` |
| Qualify a company | Paste a company name / careers URL, or `/career-ops qualify` |
| Discover buying signals | `/career-ops scan` |
| Process the signal inbox | `/career-ops pipeline` |
| Batch qualify | `/career-ops batch` |
| Check CRM status | `/career-ops tracker` |

## Verify setup

```bash
node doctor.mjs --json          # cold-start + prerequisites
node verify-pipeline.mjs        # CRM integrity (active ICP)
```

## Build the dashboard (optional)

```bash
cd dashboard
go build -o signals-dashboard .
./signals-dashboard --path ..   # opens the TUI CRM viewer
```
