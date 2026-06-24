# Architecture

## Vendor model: one vendor, many ICPs

Sales-Signals is **vendor-centric**: there is **one seller** (`config/vendor.yml`) and **many
ICPs** (ideal customer profiles), each fully isolated under `icps/<slug>/`. Every data-touching
command operates on the **active ICP**, selected by the host launcher. Operating on one ICP never
reads or writes another's files — the core isolation invariant.

```
config/vendor.yml          ← the one seller identity + Unipile account reference
icps/
  acme/                    ← one ICP
    icp.md                 ← offering, firmographics, signal→need mapping
    signals.yml            ← buying-signal role queries + filters
    pipeline.md            ← detected-signal inbox
    prospects.md           ← CRM (one row per account, append-only)
    prospects.db           ← derived SQLite index (rebuildable)
    scan-history.tsv       ← per-ICP dedup
    reports/               ← account dossiers
  globex/                  ← another ICP, fully isolated
```

## System overview

```
                    ┌─────────────────────────────────┐
                    │         AI Coding CLI Agent      │
                    │   (reads AGENTS.md + modes/*.md) │
                    └──────────┬──────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   bin/signals.mjs   │  --icp <slug>
                    │  (host launcher)    │
                    └──────────┬──────────┘
                               │  lib/icp-paths.mjs → CAREER_OPS_* env
            ┌──────────────────┼──────────────────────┐
            │                  │                       │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌───────────▼────────┐
     │ auto-pipe   │   │ scan        │   │   batch            │
     │ (qualify 1) │   │ (discover)  │   │   (qualify N)      │
     └──────┬──────┘   └──────┬──────┘   └───────────┬────────┘
            │                  │                       │
            │           ┌──────▼──────┐                │
            │           │ pipeline.md │                │
            │           │ (signal     │                │
            │           │  inbox)     │                │
            │           └─────────────┘                │
            │                                          │
     ┌──────▼──────────────────────────────────────────▼──────┐
     │                    Output                               │
     │  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐ │
     │  │ Dossier  │  │ Contact      │  │ CRM TSV          │ │
     │  │ (report) │  │ (Unipile)    │  │ (merge-tracker)  │ │
     │  └──────────┘  └──────────────┘  └──────────────────┘ │
     └────────────────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ icps/<slug>/         │
                    │   prospects.md (CRM) │
                    └──────────────────────┘
```

## Discovery flow (scan)

1. **Read config**: the active ICP's `signals.yml` (`title_filter`, `location_filter`,
   `tracked_companies`, `search_queries`, optional `unipile-jobs` provider).
2. **Discover** companies hiring the signal role:
   - **Unipile LinkedIn Jobs** (primary) — one search returns many companies.
   - **Zero-token ATS feeds** (Greenhouse / Ashby / Lever) + local parsers.
   - **WebSearch** `site:` queries (complement), then Playwright liveness verify.
3. **Filter** by title/location, **dedup** against `scan-history.tsv` + `pipeline.md` + `prospects.md`.
4. **Aggregate** openings up per company (`aggregate-signals.mjs`) with a signal-strength score
   (count, seniority, recency, repetition).
5. **Write** company-grouped signals to `pipeline.md` for qualification.

## Qualification flow (one account)

1. **Input**: a company name / careers URL / a `pipeline.md` signal line.
2. **Score** account-fit across 5 dimensions (ICP fit, signal strength/intent, timing,
   reachability, deal potential) against the ICP's `icp.md`.
3. **Liveness**: confirm the signal posting is still live (Playwright).
4. **Contact** (Phase 5): extract the decision-maker via Unipile Sales Navigator.
5. **Write** an account dossier `reports/{num}-{company}-{date}.md` + a CRM TSV addition.

## Batch processing

```
batch-input.tsv    →  batch-runner.sh  →  N × headless CLI workers
(id, url, source)     (orchestrator)       (self-contained prompt)
                           │
                    batch-state.tsv
                    (tracks progress)
```

Each worker is a headless AI CLI instance (`--cli claude` / `--cli opencode`). The orchestrator
manages parallelism, state, retries, and resume. Workers produce an account dossier + a CRM TSV
line, merged by `merge-tracker.mjs`.

## CRM integrity

| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges batch TSV additions into `prospects.md` (append-only, one row per account) |
| `verify-pipeline.mjs` | Health check: canonical statuses, one-row-per-account, links |
| `dedup-tracker.mjs` | Collapses duplicate account rows (never downgrades status) |
| `normalize-statuses.mjs` | Maps status aliases to canonical sales states |
| `tracker.mjs` | SQLite derived index over `prospects.md` |

The CRM is **append-only**: an account row's status is the MAX rank ever reached; it is never
downgraded by a later weaker signal and never deleted (proven by `account-dedup-safety-tests.mjs`).

## Dashboard TUI

The `dashboard/` directory contains a standalone Go TUI that visualizes the prospect CRM:

- Filter tabs by sales stage (New, Qualified, Contacted, Meeting, Opportunity, Won, …)
- Sort modes: Score, Date, Company, Status
- Grouped/flat view, lazy-loaded dossier previews, inline status picker

Point it at an ICP root: `./signals-dashboard --path ..`.
