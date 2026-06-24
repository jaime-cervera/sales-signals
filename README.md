# Sales-Signals

<p align="center">
  <em>One vendor. Many ideal customers. Every buying signal worth chasing.</em><br>
  <strong>Turn any AI coding CLI into a B2B buying-signal prospecting engine.</strong>
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Built_with-Claude_Code-000?style=for-the-badge&logo=anthropic&logoColor=white" alt="Built with Claude Code"></a>
</p>

<p align="center">
  <sub>Also runs on any agent-skill-standard CLI</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Gemini CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
</p>

## What Is This

Sales-Signals turns any AI coding CLI into a B2B prospecting command center. Instead of buying a static account list, you get an AI-powered pipeline that discovers **companies showing buying signals** — companies hiring a role that implies they need what you sell — scores them by fit, and surfaces the decision-maker to contact.

A **buying signal** is a company hiring a specific profile that implies a need for your service. A company hiring an "LLMOps Engineer" signals it is building LLM infrastructure — a prospect for an observability product. Sales-Signals detects these signals for free (zero-token ATS feeds + LinkedIn Jobs via Unipile + agent WebSearch with liveness verification), then qualifies each account against your **ICP** (ideal customer profile).

The model is **vendor-centric**: one vendor (you) sells one offering into **many ICPs**, each with its own buying-signal definitions, pipeline, and CRM tracker — fully isolated from one another.

- **Discovers unknown companies** hiring your signal role (not a fixed account list)
- **Scores each account** by ICP fit + signal strength + timing, rolled up per company
- **Extracts the decision-maker** to contact via LinkedIn Sales Navigator (Unipile API)
- **Tracks everything** in a file-based CRM with integrity checks

> **Human-in-the-loop by design.** Sales-Signals drafts; you send. It never auto-sends outreach. Always review before reaching out.

## Features

| Feature | Description |
| ------- | ----------- |
| **Multi-ICP** | Define many ideal customer profiles, each with its own buying signals, pipeline, and CRM — isolated per ICP |
| **Signal Discovery** | Unipile (LinkedIn Jobs) as the primary engine + zero-token ATS feeds (Greenhouse, Ashby, Lever) + WebSearch complement |
| **Account-Fit Scoring** | 5-dimension score: ICP fit, signal strength/intent, timing, reachability, deal potential — rolled up per account |
| **Decision-Maker Contacts** | Extract the right contact per qualified account via LinkedIn Sales Navigator (Unipile) |
| **File-based CRM** | One row per account, append-only, with automated merge, dedup, and status normalization |
| **Liveness Verification** | Playwright confirms a discovered signal is still live before it enters the pipeline |
| **Batch Processing** | Parallel qualification with headless CLI workers (`claude -p` / `opencode run`) |
| **Dashboard TUI** | Terminal UI to browse, filter, and sort your prospect CRM |

## Quick Start

```bash
git clone <your-fork-url> sales-signals
cd sales-signals && npm install
npx playwright install chromium   # only needed for liveness verification

# Configure Unipile (LinkedIn discovery + Sales Navigator contacts)
cp .env.example .env               # add UNIPILE_API_KEY / UNIPILE_DSN / UNIPILE_ACCOUNT_ID
cp config/vendor.example.yml config/vendor.yml   # your seller identity

# Check setup
npm run doctor                     # validates prerequisites

# Open your AI CLI in this directory
claude   # or gemini / codex / qwen / opencode
```

**On first launch, Sales-Signals walks you through onboarding your first ICP — your offering, the firmographics you target, and the buying-signal roles that map to a need — just by chatting. Nothing to edit by hand.**

> **The system is designed to be customized by your AI coding CLI itself.** Modes, scoring weights, ICP definitions — just ask it to change them. It reads the same files it uses, so it knows exactly what to edit.

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide.

## Usage

Sales-Signals is a single slash command with multiple modes:

```
/career-ops                → Show all available commands
/career-ops icp            → Onboard / create a new ICP (buying-signal profile)
/career-ops {company}      → Auto-pipeline: qualify account + dossier + tracker
/career-ops scan           → Scan for buying signals and discover new accounts
/career-ops qualify        → Qualify a company's buying signal (account-fit score)
/career-ops batch          → Batch qualify multiple accounts
/career-ops tracker        → View prospect CRM status
/career-ops pipeline       → Process pending companies
/career-ops deep           → Deep account research
/career-ops patterns       → Analyze disqualification patterns
/career-ops followup       → Follow-up cadence tracker
```

> **Note:** the slash command and skill directory are named `career-ops` for historical reasons (renaming the skill would break the CLI symlinks). The product is **Sales-Signals**.

Or just paste a company name or careers URL directly — Sales-Signals auto-detects the buying signal and qualifies the account.

## Multi-ICP & Active-ICP Scoping

Every data-touching command operates on the **active ICP**. Select it with the host launcher:

```bash
node bin/signals.mjs scan --icp acme        # scan for the "acme" ICP
node bin/signals.mjs qualify --icp acme Stripe
node bin/signals.mjs scan --icp newslug --create-icp   # create on the fly
```

Each ICP lives under `icps/<slug>/` with its own `signals.yml`, `icp.md`, `prospects.md` (CRM), pipeline, scan history, and reports. Operating on one ICP never reads or writes another's files.

### Environment variables (grandfathered names)

The launcher resolves per-ICP paths and exports a set of `CAREER_OPS_*` environment variables (e.g. `CAREER_OPS_ICP`, `CAREER_OPS_TRACKER`, `CAREER_OPS_PORTALS`) that the underlying scripts read. **These env-var names are kept from the upstream project on purpose** — renaming them is churn with migration risk and no user value, so they remain `CAREER_OPS_*` even though the product is Sales-Signals. See [DATA_CONTRACT.md](DATA_CONTRACT.md).

## How It Works

```
You scan an ICP (or paste a company)
        │
        ▼
┌──────────────────┐
│  Signal          │  Unipile Jobs + ATS feeds + WebSearch
│  Discovery       │  → companies hiring the signal role
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Aggregation     │  Roll openings up per company (account)
│  + signal score  │  → signal strength (count, seniority, recency)
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Qualification   │  Account-fit score vs the ICP (5 dimensions)
│  (reads icp.md)  │  + decision-maker contact (Unipile Sales Nav)
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Dossier CRM  Contact
  .md  prospects.md
```

## Discovery & Liveness

By default `node scan.mjs` (a.k.a. `npm run scan`) trusts what each source returns. Some companies leave stale postings in their public feeds even after the role is closed, so those expired signals can leak into the pipeline. Pass `--verify` to launch Playwright after the API pass and drop expired signals before they hit the pipeline:

```bash
node scan.mjs --verify          # zero-token discovery + Playwright liveness check
```

The verification is sequential and only runs against new signals (after dedup), so the cost stays bounded.

## Dashboard TUI

The built-in terminal dashboard lets you browse your prospect CRM visually:

```bash
cd dashboard
go build -o signals-dashboard .
./signals-dashboard --path ..
```

Features: filter tabs, sort modes, grouped/flat view, lazy-loaded previews, inline status changes.

## Project Structure

```
sales-signals/
├── AGENTS.md                    # Canonical agent instructions (all CLIs)
├── CLAUDE.md                    # Claude Code wrapper (imports AGENTS.md)
├── OPENCODE.md                  # OpenCode wrapper (imports AGENTS.md)
├── config/
│   └── vendor.example.yml       # Template for your seller identity
├── icps/                        # One directory per ICP (gitignored user data)
│   └── <slug>/
│       ├── icp.md               # ICP definition (offering, firmographics, signal→need)
│       ├── signals.yml          # Buying-signal role queries + filters
│       ├── prospects.md         # CRM tracker (one row per account)
│       ├── pipeline.md          # Detected-signal inbox
│       └── reports/             # Account qualification dossiers
├── bin/
│   └── signals.mjs              # Host launcher — resolves the active ICP
├── lib/
│   └── icp-paths.mjs            # ICP slug → per-ICP path resolver
├── providers/                   # Discovery providers (ATS + Unipile Jobs)
├── modes/                       # Skill modes (shared across ICPs)
├── templates/
│   ├── icp.template.md          # ICP definition template
│   ├── signals.example.yml      # Scanner config template
│   └── states.yml               # Canonical sales states
├── batch/                       # Batch worker prompt + orchestrator
├── dashboard/                   # Go TUI CRM viewer
├── docs/                        # Setup, customization, architecture
└── examples/                    # Sample data
```

## Tech Stack

- **Agent**: Claude Code (or any agent-skill-standard CLI) with custom skills and modes
- **Discovery**: Unipile (LinkedIn Jobs + Sales Navigator) + Greenhouse/Ashby/Lever APIs + WebSearch
- **Liveness**: Playwright
- **Dashboard**: Go + Bubble Tea + Lipgloss
- **Data**: Markdown tables + YAML config + TSV files

## Disclaimer

**Sales-Signals is a local, open-source tool, NOT a hosted service.** By using this software, you acknowledge:

1. **You control your data.** Your ICP definitions, prospect data, and contact information stay on your machine and are sent directly to the AI provider you choose. We do not collect, store, or have access to any of your data.
2. **You control the AI.** The default prompts instruct the AI not to auto-send outreach, but AI models can behave unpredictably. If you modify the prompts or use different models, you do so at your own risk. **Always review AI-generated content for accuracy before sending.**
3. **You comply with third-party ToS.** You must use this tool in accordance with the Terms of Service of the services you interact with (Greenhouse, Lever, Workday, LinkedIn, Unipile, etc.). Use the sanctioned Unipile API on your own connected account; do not spam or overwhelm any system.
4. **You handle contact data responsibly.** Decision-maker PII you extract is your responsibility to store and process lawfully (e.g. GDPR). Keep only what you need; a purge capability is provided.

See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) for full details. This software is provided under the [MIT License](LICENSE) "as is", without warranty of any kind.

## License

The code is licensed under the [MIT License](LICENSE).
