# Mode: tracker — Prospect CRM View

Read and display the active ICP's CRM tracker `icps/<slug>/prospects.md` (the path is
resolved by `bin/signals.mjs --icp <slug>` via `lib/icp-paths.mjs`).

**Tracker Format** (canonical schema — see `templates/crm-schema.md`):

```markdown
| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
```

One row **per account (company)**, append-only. The CRM is keyed by the
company-normalized `Company` name.

**Sales pipeline states** (see `templates/states.yml`):

`New` → `Qualified` → `Contacted` → `Replied` → `Meeting` → `Opportunity` → `Won`
plus the terminal `Lost` / `Disqualified`.

- `New` = buying signal detected, not yet qualified
- `Qualified` = scored, fits the ICP, worth pursuing
- `Contacted` = outreach sent to a decision-maker
- `Replied` = prospect replied to outreach
- `Meeting` = meeting / demo booked
- `Opportunity` = active sales opportunity / open deal
- `Won` = closed-won — became a customer
- `Lost` = closed-lost — deal did not close
- `Disqualified` = not a fit (no genuine signal / out of ICP)

**Status is the MAX rank ever reached** — never downgrade an account to a weaker
state, and never delete a row. If the user asks to advance an account, edit the
`Status` cell in that company's row.

Also show statistics:
- Total accounts (prospects)
- Breakdown by status
- Average `ICPScore`
- % with a decision-maker `Contact` captured
- % with an account dossier `Report` generated
