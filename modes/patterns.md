# Mode: patterns -- Which Buying Signals Convert (Win/Loss Analysis)

## Purpose

Analyze all tracked accounts to find **which buying signals convert into deals** and which leak. Groups accounts by the **Signal** (the buying trigger) and by **ICP-fit band**, classifies outcomes by sales **Status** (Won/Opportunity = conversion; Lost/Disqualified = loss), and surfaces win/loss patterns plus a data-driven ICP-score floor. Scoped to the **active ICP** (`icps/<slug>/prospects.md`).

## Inputs

- `icps/<slug>/prospects.md` — CRM tracker (set via `CAREER_OPS_TRACKER`)
- `icps/<slug>/reports/` — Account dossiers (`CAREER_OPS_REPORTS`)
- `icp.md` / `config/vendor.yml` — ICP definition + the offering (for recommendation context)

The tracker is the 8-column CRM table (columns mapped by **header NAME**, not position):

```
| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
```

## Minimum Threshold

Before running analysis, check: does the tracker have at least 5 accounts **worked beyond "Qualified"** (i.e., Contacted, Replied, Meeting, Opportunity, Won, Lost, Disqualified)?

If not, the script returns an error with `current`/`threshold`. Tell the user:
> "Not enough data yet -- {N}/5 accounts have been worked beyond qualification. Keep working signals and come back when you have more outcomes to analyze."

Exit gracefully.

## Step 1 — Run Analysis Script

Execute:

```bash
node analyze-patterns.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Total accounts, date range, analysis date, counts by outcome (conversion / in_pipeline / loss / untouched) |
| `funnel` | Count per sales stage (new, qualified, contacted, replied, meeting, opportunity, won, lost, disqualified) |
| `scoreComparison` | Avg/min/max ICP score per outcome group |
| `signalConversion` | Per buying-signal: total, won (conversion), in_pipeline, loss, **conversionRate** (won / decided) |
| `icpFitBreakdown` | Per ICP-fit band (strong/good/marginal/weak/unscored): total, won, loss, conversion rate |
| `scoreThreshold` | Recommended minimum ICP score + reasoning (lowest score that ever converted) |
| `recommendations` | Top actionable items with reasoning and impact level |

If the script returns `error`, display the error message and exit.

**Outcome buckets:** conversion rate is computed over *decided* accounts only (`conversion + loss`); in_pipeline and untouched accounts are excluded from the rate so an open pipeline doesn't drag it down.

## Step 2 — Generate Report

Write the report to `icps/<slug>/reports/signal-conversion-{YYYY-MM-DD}.md`.

### Report Structure

```markdown
# Buying-Signal Conversion Analysis -- {YYYY-MM-DD}

**Accounts analyzed:** {total}
**Date range:** {from} to {to}
**Outcomes:** {conversion} converted, {in_pipeline} in pipeline, {loss} lost, {untouched} untouched

---

## Pipeline Funnel

| Stage | Count | % |
|-------|-------|---|
| New | X | X% |
| Qualified | X | X% |
| Contacted | X | X% |
| ... | | |

## Which Signals Convert

| Signal | Total | Won | Lost | In Pipeline | Win Rate |
|--------|-------|-----|------|-------------|----------|

Highlight the highest-converting signal and the leakiest (0% across decided accounts).

## ICP Score vs Outcome

| Outcome | Avg Score | Min | Max | Count |
|---------|-----------|-----|-----|-------|
| Conversion | X.X/5 | | | |
| In pipeline | | | | |
| Loss | | | | |

## ICP-Fit Bands

| Band | Total | Won | Win Rate |
|------|-------|-----|----------|

## Recommended ICP Score Threshold

State the data-driven minimum score (lowest score that ever converted) and reasoning.

## Recommendations

Number the top recommendations (from the script output). For each:
1. **[IMPACT]** Action to take
   Reasoning behind the recommendation.
```

## Step 3 — Present Summary

Show the user a condensed version with:
1. One-line stat summary (X accounts, Y% converted, Z in pipeline)
2. Top 3 findings (best/worst signals, score floor)
3. Link to full report

Example:
> **Signal Conversion Analysis Complete** (18 accounts, Jan 1-30)
>
> Key findings:
> - "LLMOps Engineer" signals convert at 80% (4 of 5 decided) -- your sweet spot
> - "Data Platform Lead" signals are 0% across 3 decided accounts -- deprioritize
> - No account below 4.2/5 ICP fit has converted -- treat that as your score floor
>
> Full report: `icps/<slug>/reports/signal-conversion-2026-01-30.md`

## Step 4 — Offer to Act on Recommendations

Ask the user whether to act:

> "Want me to act on any of these? I can:
> - Tighten the ICP's signal definitions to favor the converting signal roles
> - Set a minimum ICP score before an account is worked
> - Deprioritize the leaky signals in the next scan
>
> Just say which ones, or 'all' to apply everything."

If the user agrees:
- For signal-definition changes: edit the active ICP's `signals.yml` / `icp.md`
- For score floor: add it under a `patterns` key in `config/profile.yml`

## Outcome Classification

For reference, sales Status maps to outcome as:

| Status | Outcome |
|--------|---------|
| Won, Opportunity | **Conversion** (the signal turned into a deal) |
| Contacted, Replied, Meeting | **In pipeline** (active, no verdict yet) |
| Lost, Disqualified | **Loss** (the signal did not convert) |
| New, Qualified | **Untouched** (not yet worked) |
