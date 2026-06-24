# Sales-Signals -- B2B Buying-Signal Prospecting

## About

Sales-Signals is a vendor-centric B2B prospecting system: one vendor (the user) sells one
offering into **many ICPs** (ideal customer profiles), and the system discovers companies
showing a **buying signal** for each ICP, qualifies them by account-fit, extracts the
decision-maker to contact, and tracks everything in a file-based CRM.

A **buying signal** = a company hiring a profile that implies it needs the user's service
(e.g. a company hiring an "LLMOps Engineer" signals it is building LLM infrastructure → a
prospect for an observability product).

**It works out of the box, but it's designed to be made yours.** If the scoring weights don't
fit, the signal roles need tuning, or an ICP needs new firmographics -- just ask. You (AI Agent)
can edit the user's files directly. That's the whole point.

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `config/vendor.yml`, `icps/<slug>/icp.md`, `icps/<slug>/signals.yml`
- `icps/<slug>/data/*`, `icps/<slug>/reports/*`, `output/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/_shared.md`, `modes/qualify.md`, all other modes
- `AGENTS.md`, `CLAUDE.md`, `OPENCODE.md`, `*.mjs` scripts, `dashboard/*`, `templates/*`, `batch/*`

**THE RULE: When the user asks to customize anything (firmographics, signal→need mapping, value
proposition, disqualifiers, scoring weights), ALWAYS write to the active `icps/<slug>/icp.md` or
`config/vendor.yml`. NEVER edit `modes/_shared.md` for user-specific content.** This ensures
system updates don't overwrite their customizations.

### Grandfathered env-var names

The launcher `bin/signals.mjs` resolves per-ICP paths and exports a set of `CAREER_OPS_*`
environment variables (`CAREER_OPS_ICP`, `CAREER_OPS_TRACKER`, `CAREER_OPS_PORTALS`, etc.) that
the scripts read. **These names are kept from the upstream project on purpose** -- renaming them
is churn with no user value -- so they stay `CAREER_OPS_*` even though the product is Sales-Signals.

## What is Sales-Signals

AI-powered, CLI-agnostic B2B prospecting: multi-ICP buying-signal discovery, account-fit
qualification, decision-maker contact extraction (via Unipile / LinkedIn Sales Navigator), and a
file-based CRM. Runs on any AI coding CLI that follows the [open agent skill
standard](https://agentskills.io) (Claude Code, Codex, Gemini, OpenCode, Qwen, Copilot, Kimi).

### Main Files

| File | Function |
|------|----------|
| `icps/<slug>/prospects.md` | CRM tracker (one row per account) |
| `icps/<slug>/pipeline.md` | Inbox of detected buying signals to qualify |
| `icps/<slug>/scan-history.tsv` | Scanner dedup history |
| `icps/<slug>/signals.yml` | Buying-signal role queries + filters for this ICP |
| `icps/<slug>/icp.md` | This ICP's definition (offering, firmographics, signal→need) |
| `config/vendor.yml` | The one seller identity + Unipile account reference |
| `aggregate-signals.mjs` | Roll openings up per company with a signal-strength score |
| `analyze-patterns.mjs` | Pattern analysis script (JSON output) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON output) |
| `scan.mjs` | Zero-token signal scanner — hits Greenhouse/Ashby/Lever + Unipile Jobs, zero LLM cost |
| `check-liveness.mjs` | Signal liveness checker |
| `liveness-core.mjs` | Shared liveness logic (expired signals win over generic Apply text) |
| `reports/` | Account dossiers (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`) |

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** On the first message of each
session, run the cold-start check — one deterministic source of truth (this doc and `doctor.mjs`
share the same prerequisite list, so they can never drift):

```bash
node doctor.mjs --json
```

Output: `{"onboardingNeeded": <bool>, "missing": [...], "warnings": [...]}`, where `missing` lists
whichever of `config/vendor.yml`, `icps/<slug>/signals.yml`, `icps/<slug>/icp.md` are absent.
`warnings` is reserved for non-blocking setup signals.

- **If `onboardingNeeded` is true (any of `config/vendor.yml` / `icps/<slug>/signals.yml` /
  `icps/<slug>/icp.md` is missing), enter onboarding mode.** Do NOT proceed with scans,
  qualification, or any other mode until the basics are in place. Run the `icp` onboarding mode
  (or `bin/signals.mjs <mode> --icp <slug> --create-icp`) and guide the user step by step.

#### Step 1: Vendor identity (required)
If `config/vendor.yml` is missing, copy from `config/vendor.example.yml` and then ask:
> "Let's set up your seller identity:
> - Your company name and what you sell (one line)
> - Your website and default target geography
> - Your Unipile account reference (for LinkedIn discovery + Sales Navigator contacts)
>
> I'll set everything up for you."

#### Step 2: ICP definition (required)
Drive the `icp` onboarding mode to capture the first ICP's `icp.md`: the offering, the value
proposition, the target firmographics (industry / company size / geography / tech stack), and the
**signal→need mapping** (which hiring signals imply a need for the offering).

#### Step 3: Signals config (recommended)
Materialize `icps/<slug>/signals.yml` from `templates/signals.example.yml`. Set
`title_filter.positive` to the buying-signal roles for this ICP (the roles that, when a company
hires for them, indicate the need you sell into).

#### Step 4: CRM tracker
The scaffolder creates `icps/<slug>/prospects.md` with the canonical CRM header. One row per
account (company), append-only — see `templates/crm-schema.md`.

#### Step 5: Get to know the offering (important for quality)

After the basics are set up, proactively ask for more context. The more you know, the better your
qualification will be:

> "The basics are ready. But the system qualifies far better when it knows your offering well:
> - What problem does your product solve, and for whom?
> - What hiring signals most strongly predict a company needs it?
> - Any disqualifiers? (e.g. company size floor, industries to avoid, geos out of scope)
> - Your best reference customers — the profile of an ideal account
>
> The more context you give me, the sharper I filter."

Store insights in the active `icps/<slug>/icp.md`. Do not put ICP-specific framing into
`modes/_shared.md`.

**After every qualification, learn.** If the user says "this score is too high, this isn't a real
prospect" or "you missed that they're already a customer", update your understanding in the active
`icps/<slug>/icp.md`. The system should get sharper with every interaction without putting
ICP-specific content into system-layer files.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a company name or careers URL to qualify it
> - Run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) to discover buying signals
> - Run `/career-ops` to see all commands
>
> Everything is customizable — just ask me to change anything."

Then suggest automation:
> "Want me to scan for new buying signals automatically? I can set up a recurring scan every few
> days so you don't miss a signal. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring
`/career-ops scan` (or `/career-ops-scan` if using OpenCode). If those aren't available, suggest a
cron job or remind them to run `/career-ops scan` periodically.

### Personalization

This system is designed to be customized by YOU (AI Agent). When the user asks you to adjust
scoring, tune signal roles, add firmographics, or refine an ICP -- do it directly. You read the
same files you use, so you know exactly what to edit.

**Common customization requests:**
- "Tune the buying-signal roles for this ICP" → edit `icps/<slug>/signals.yml`
- "Change the firmographics / disqualifiers" → edit `icps/<slug>/icp.md`
- "Add these companies to track" → edit `icps/<slug>/signals.yml`
- "Adjust the account-fit scoring weights" → edit the active `icps/<slug>/icp.md` for ICP-specific
  weighting, or edit `modes/_shared.md` and `batch/batch-prompt.md` only when changing the shared
  system defaults for everyone

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Wants to create / onboard an ICP (buying-signal profile) | `icp` |
| Names a company / URL showing a buying signal | auto-pipeline (qualify account + dossier + tracker) |
| Asks to qualify a company's buying signal | `qualify` |
| Asks for company / account research | `deep` |
| Asks about prospect / CRM status | `tracker` |
| Searches for new buying signals | `scan` |
| Processes pending companies | `pipeline` |
| Batch processes accounts | `batch` |
| Asks about disqualification patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or outreach cadence | `followup` |

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and reach
out to accounts where there is a genuine fit -- not to spam companies with mass outreach.

- **NEVER send outreach without the user reviewing it first.** Draft messages, prepare contact
  lists -- but always STOP before sending. The user makes the final call.
- **Strongly discourage low-fit outreach.** If an account-fit score is below 4.0/5, explicitly
  recommend against reaching out. The user's time and the prospect's time are both valuable.
- **Quality over speed.** A well-targeted message to 5 accounts beats a generic blast to 50. Guide
  the user toward fewer, better conversations.
- **Respect the LinkedIn ToS and the prospect's attention.** Use only the sanctioned Unipile API on
  the user's own connected account; keep query volume modest; honor rate limits.
- **Handle PII responsibly.** Decision-maker contact data is personal data. Keep only what's needed
  and use the purge capability when asked.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if a signal (job posting) is still active.** ALWAYS use
Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without a job description = closed. Title + description + Apply = active (live
   signal).

**Exception for batch workers (headless mode):** Playwright is not available in headless pipe mode.
Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch
mode)`. The user can verify manually later.

---

## Headless / Batch Mode

When spawning headless workers for batch processing, use the appropriate command for your CLI:

| CLI | Command |
|-----|---------|
| Claude Code | `claude -p "prompt"` |
| **OpenCode** | `opencode run "prompt"` |
| Gemini CLI | `gemini -p "prompt"` |
| Copilot CLI | `copilot -p "prompt"` |
| Codex | `codex exec "prompt"` |
| Qwen | `qwen -p "prompt"` |

## Stack and Conventions

- Node.js (mjs modules), Playwright (liveness verification + scraping), YAML (config), Markdown (data)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- Batch in `batch/` (gitignored except scripts and prompt)
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of qualifications, run `node merge-tracker.mjs`** to merge tracker
  additions and avoid duplications.
- **RULE: NEVER create a new account row in `prospects.md` if the company already exists.** Update
  the existing row (the CRM is append-only, one row per account).

### TSV Format for Tracker Additions

Write one TSV file per qualification to `batch/tracker-additions/{num}-{company-slug}.tsv`. The
account-CRM schema is defined in `templates/crm-schema.md`; the merge script normalizes report
links and folds repeated signals into one account row.

**Account CRM columns (see `templates/crm-schema.md`, one row per account):**
1. `Company` -- account name (the dedup key, company-normalized)
2. `Signal` -- the buying-signal role(s) detected (e.g. "LLMOps Engineer ×2")
3. `SignalDate` -- YYYY-MM-DD of the newest signal
4. `ICPScore` -- account-fit score `X.X/5`
5. `Status` -- canonical sales state (see `templates/states.yml`)
6. `Contact` -- decision-maker (name / LinkedIn) or `—`
7. `Report` -- markdown link to the account dossier, or `—`
8. `Notes` -- free text; also holds the appended signal history

**Report link normalization:** `merge-tracker.mjs` rewrites the report link so it is relative to
the tracker file's own directory before writing it into the tracker. Normalization is idempotent.
To fix links in an existing tracker, run `node merge-tracker.mjs --migrate`.

### Pipeline Integrity

1. **NEVER edit `prospects.md` to ADD new accounts** -- Write TSV in `batch/tracker-additions/` and
   `merge-tracker.mjs` handles the merge.
2. **YES you can edit `prospects.md` to UPDATE status/notes of an existing account.**
3. All reports MUST include `**URL:**` in the header (see the qualification dossier format in
   `modes/qualify.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node verify-pipeline.mjs`
6. Normalize statuses: `node normalize-statuses.mjs`
7. Dedup: `node dedup-tracker.mjs`

### Canonical States (prospects.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `New` | Buying signal detected, not yet qualified |
| `Qualified` | Scored, fits the ICP, worth pursuing |
| `Contacted` | Outreach sent to a decision-maker |
| `Replied` | Prospect replied to outreach |
| `Meeting` | Meeting / demo booked |
| `Opportunity` | Active sales opportunity / open deal |
| `Won` | Closed-won — became a customer |
| `Lost` | Closed-lost — deal did not close |
| `Disqualified` | Not a fit (no genuine signal / out of ICP) |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
- Status is append-only: never downgrade an account by a later weaker signal; never delete a row.
