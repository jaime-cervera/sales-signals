# `prospects.md` — Locked CRM Schema (single source of truth)

> The canonical **column set + order** for the per-ICP CRM tracker
> (`icps/<slug>/prospects.md`). Phase 4 (the writers/parsers) and the Go dashboard
> read against THIS document so they cannot diverge. Parallels `signals-schema.md`.
>
> This replaces the upstream job `applications.md` (9 cols, `score`-before-`status`).
> The CRM is **one row per account (company)**, append-only.

## Columns (8, in this exact order)

| # | Header | Meaning |
|---|--------|---------|
| 1 | `Company` | Account name (the dedup key, company-normalized) |
| 2 | `Signal` | The buying-signal role(s) detected (e.g. "LLMOps Engineer ×2") |
| 3 | `SignalDate` | Date the (newest) signal was detected (YYYY-MM-DD) |
| 4 | `ICPScore` | Account-fit score `X.X/5` |
| 5 | `Status` | Canonical sales state (see `states.yml`) |
| 6 | `Contact` | Decision-maker contact (name / LinkedIn) or `—` |
| 7 | `Report` | Markdown link to the account dossier, or `—` |
| 8 | `Notes` | Free text; also holds the appended signal history |

### Header + separator (canonical literals)

```
| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
|---------|--------|------------|----------|--------|---------|--------|-------|
```

## Parsing rules

- Parsers map columns **by header NAME**, never by fixed position (the old job
  layout was positional with `score` before `status`; this layout removes `num`
  and reorders, so any positional parser must be rewritten).
- `ICPScore` maps to the old `score` token for header-alias compatibility;
  `num` is no longer required.
- `Status` must be a canonical label from `states.yml` (case-insensitive).

## Append-only account model (the #947/#751 safety, redefined)

- **One row per account (company)**, keyed by the normalized company name.
- A second signal for an existing account is **merged into that one row**: the
  `Signal`/`Notes` accumulate a signal history, `SignalDate` advances to the
  newest, `ICPScore` may rise.
- **Status is the MAX `rank` ever reached** (`states.yml`): never downgraded by a
  later weaker signal.
- **A row is NEVER deleted.** A `Won`/`Opportunity`/`Meeting` account cannot be
  removed or downgraded by a later same-company signal. Proven independently by
  `account-dedup-safety-tests.mjs`.
- Role-level fuzzy matching (`role-matcher.mjs`) is **no longer** used for tracker
  identity (company-normalized key only); it remains available for other role
  comparisons.

## Go dashboard

The Go model field-name mapping for these columns is filled in by Unit 4.5
(`dashboard/internal/data/career.go` + `model/career.go`), which parses by header
NAME and writes back only canonical sales states. UX (tabs/labels) is Unit 6.2.
