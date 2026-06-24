# Mode: pipeline — Signal Inbox (Second Brain)

> **Sales-Signals (Unit 4.4):** the pipeline is the **active ICP's detected-signal
> inbox** (`icps/<slug>/pipeline.md`, company-grouped). Processing each entry runs
> the `qualify` flow on that company and folds the result into the ICP's CRM
> (`prospects.md`). Run scoped via `bin/signals.mjs pipeline --icp <slug>`.

Process detected-signal entries stored in the active ICP's `pipeline.md`. The scanner adds company-grouped signals; run `bin/signals.mjs pipeline --icp <slug>` to qualify them all.

## Workflow

1. **Read** the active ICP's `pipeline.md` → search for `- [ ]` items in the "Pending" section
2. **For each pending URL**:
   a. Claim the next sequential `REPORT_NUM` atomically by running `node reserve-report-num.mjs` (and release the sentinel using `node reserve-report-num.mjs --release <num>` after the report is written)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. If the URL is not accessible → mark as `- [!]` with a note and continue
   d. **Execute full auto-pipeline**: account-fit qualification → dossier .md → CRM update
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Signal | ICPScore/5 | Status`
3. **If there are 3+ pending companies**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **At the end**, show summary table:

```
| # | Company | Signal | ICPScore | Status | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | LLMOps Engineer
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | LLMOps Engineer | 4.2/5 | Qualified
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | Data Engineer | 2.1/5 | Disqualified
```

## Intelligent JD detection from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search in secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:companies/acme.md` → read `companies/acme.md`

## Automatic numbering

1. Run `node reserve-report-num.mjs` to claim the next sequential number (stdout returns `{###}`).
2. Write the dossier file using that number.
3. Release the sentinel by running `node reserve-report-num.mjs --release {###}` once the dossier is written.
