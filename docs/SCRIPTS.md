# Scripts Reference

Scripts live in the project root as `.mjs` modules. Data-touching scripts are scoped to the
**active ICP** by the host launcher `bin/signals.mjs` (which resolves `--icp <slug>` and exports
the `CAREER_OPS_*` path env vars). Some are also exposed via `npm run <name>`.

## Quick Reference

| Command | Script | Purpose |
|---------|--------|---------|
| `node bin/signals.mjs <mode> --icp <slug>` | `bin/signals.mjs` | Host launcher — resolve the active ICP, apply env, run the target script |
| `npm run doctor` | `doctor.mjs` | Validate setup prerequisites + cold-start onboarding check |
| `npm run scan` | `scan.mjs` | Zero-token signal scanner (ATS + Unipile Jobs) |
| `npm run scan:full` | `scan-ats-full.mjs` | Reverse ATS discovery scanner |
| — | `aggregate-signals.mjs` | Roll openings up per company with a signal-strength score |
| — | `scaffold-icp.mjs` | Materialize a new `icps/<slug>/` from templates |
| `npm run validate:signals` | `validate-signals.mjs` | Validate a per-ICP `signals.yml` (+ optional `icp.md`) |
| — | `validate-portals.mjs` | Lower-level shape validator reused by `validate-signals` |
| `npm run verify` | `verify-pipeline.mjs` | Check CRM (`prospects.md`) data integrity |
| `npm run normalize` | `normalize-statuses.mjs` | Fix non-canonical sales statuses |
| `npm run dedup` | `dedup-tracker.mjs` | Remove duplicate account rows |
| `npm run merge` | `merge-tracker.mjs` | Merge batch TSVs into `prospects.md` (append-only) |
| — | `migrate-tracker-accounts.mjs` | One-time migration to the account-CRM schema |
| `npm run tracker` | `tracker.mjs` | SQLite derived index over `prospects.md` — sync/query/history/export |
| `npm run patterns` | `analyze-patterns.mjs` | Analyze disqualification patterns from the CRM + reports |
| `npm run liveness` | `check-liveness.mjs` | Test if signal (posting) URLs are still live |
| — | `followup-cadence.mjs` | Compute follow-up cadence / overdue accounts |
| — | `find-contacts.mjs` *(planned stub)* | Extract decision-maker contacts via Unipile Sales Navigator |

---

## bin/signals.mjs (launcher)

Resolves `--icp <slug>` (default `default`) via `lib/icp-paths.mjs`, applies the `CAREER_OPS_*`
path env vars for that ICP, then runs the target mode/script on the host. Pass `--create-icp` to
scaffold a new ICP before running. An unknown slug errors and lists the available ICPs (a typo
never scaffolds junk).

```bash
node bin/signals.mjs scan --icp acme
node bin/signals.mjs qualify --icp acme Stripe
node bin/signals.mjs scan --icp newslug --create-icp
```

---

## doctor

Validates prerequisites (Node, dependencies, Playwright chromium) and runs the cold-start check:
reports `onboardingNeeded` plus which of `config/vendor.yml` / `icps/<slug>/signals.yml` /
`icps/<slug>/icp.md` are missing.

```bash
npm run doctor
node doctor.mjs --json
```

**Exit codes:** `0` all checks passed, `1` one or more checks failed.

---

## scan

Zero-token buying-signal scanner. Runs configured local parsers for SSR/static career pages, hits
ATS APIs (Greenhouse, Ashby, Lever) directly, and (Phase 3) the Unipile Jobs provider — no LLM
tokens consumed. Reads the active ICP's `signals.yml`, rolls matching openings up per company via
`aggregate-signals.mjs`, and appends company-grouped signals to the ICP's `pipeline.md`. Pass
`--verify` to Playwright-verify liveness of new WebSearch signals before they enter the pipeline.

```bash
node bin/signals.mjs scan --icp <slug>
node bin/signals.mjs scan --icp <slug> --verify
```

**Exit codes:** `0` scan completed, `1` configuration error or no `signals.yml` found.

---

## scan:full

Reverse ATS discovery scanner. Where `scan.mjs` scans the companies you track in `signals.yml`,
this walks public ATS directories (Greenhouse, Lever, Ashby, Workday) and surfaces fresh postings
matching your `title_filter` / `location_filter` — no manual company curation.

```bash
node scan-ats-full.mjs --since 7
node scan-ats-full.mjs --ats greenhouse,workday
node scan-ats-full.mjs --dry-run
```

**Exit codes:** `0` scan completed, `1` configuration or fatal scan error.

---

## aggregate-signals

Pure module that rolls individual openings up to their **company (account)** and computes a
**signal-strength** score (count, seniority, recency, repetition across scans). Used by `scan.mjs`
to produce the company-grouped pipeline blocks.

---

## scaffold-icp

Materializes a new `icps/<slug>/` directory from the locked templates (`signals.example.yml`,
`icp.template.md`): a starter `signals.yml`, `icp.md`, an empty `pipeline.md`, an empty CRM
`prospects.md` (with the canonical header), `scan-history.tsv`, and `config/profile.yml`.

```bash
node scaffold-icp.mjs --slug retailco
node scaffold-icp.mjs --slug retailco --force   # overwrite an existing slug
```

**Exit codes:** `0` created, `1` slug exists (without `--force`) or invalid slug.

---

## validate:signals / validate-portals

`validate-signals.mjs` validates a per-ICP `signals.yml` against `templates/signals-schema.md`:
`title_filter.positive` is REQUIRED non-empty, optional Unipile params and `search_queries` are
shape-checked, and a missing discovery source is warned. It reuses the lower-level shape checks in
`validate-portals.mjs` (unknown providers, malformed URLs, empty keywords, invalid parser blocks).

```bash
npm run validate:signals
node validate-signals.mjs --file icps/<slug>/signals.yml --icp-file icps/<slug>/icp.md
node validate-signals.mjs --self-test
```

**Exit codes:** `0` no errors (warnings allowed), `1` one or more errors.

---

## verify

Health check for CRM integrity. Validates `prospects.md` against the account-CRM rules: canonical
sales statuses (per `templates/states.yml`), one row per account, report links resolve, scores
well-formed, proper pipe-delimited rows, no pending TSVs in `batch/tracker-additions/`.

```bash
npm run verify
```

**Exit codes:** `0` clean, `1` errors found.

---

## normalize / dedup / merge

- **normalize** — maps non-canonical statuses to their canonical sales states and strips bold/dates
  from the status column.
- **dedup** — collapses duplicate account rows by normalized company name (append-only safe: a
  more-advanced status is preserved, never downgraded).
- **merge** — merges batch additions (`batch/tracker-additions/*.tsv`) into `prospects.md`. A new
  signal for an existing company folds into that one row; a new company adds a row. Concurrency-safe
  via a tracker lock.

```bash
npm run normalize -- --dry-run
npm run dedup -- --dry-run
npm run merge -- --dry-run
npm run merge -- --verify
```

Each creates a `.bak` backup before writing. **Exit codes:** `0` success (merge `--verify` → `1` on
verification errors).

---

## migrate-tracker-accounts

One-time migration that converts a legacy job-style tracker into the account-CRM schema (one row
per account, the `crm-schema.md` column set). Idempotent and `--dry-run` aware.

---

## tracker

SQLite **derived index** for the CRM. `prospects.md` stays the source of truth; `prospects.db` is
built from it by `sync` and is safe to delete (it regenerates). Uses `node:sqlite` (Node ≥ 22.5),
zero new dependencies.

```bash
node tracker.mjs sync                 # (re)build prospects.db from prospects.md
node tracker.mjs sync --check         # diagnose corruption only, no write
node tracker.mjs query --status Qualified --since 2026-05-01
node tracker.mjs history --company acme
node tracker.mjs export               # inverse: index → canonical markdown on stdout
```

**Exit codes:** `0` success, `1` validation error / missing prerequisites / corruption found.

---

## patterns

Analyzes disqualification patterns (why accounts were disqualified, score distribution, signal
roles, firmographics) from the CRM and linked reports, to help tune ICP targeting.

```bash
npm run patterns
node analyze-patterns.mjs --self-test
```

**Exit codes:** `0` analysis succeeded, `1` insufficient data or self-test failure.

---

## liveness

Tests whether signal (posting) URLs are still live using headless Chromium. Detects expired
patterns, HTTP 404/410, ATS redirect patterns, and apply-button presence.

```bash
node check-liveness.mjs https://example.com/job/123
node check-liveness.mjs --file urls.txt
```

**Exit codes:** `0` all live, `1` any expired or uncertain.

---

## followup-cadence

Computes follow-up timing for accounts in the CRM (overdue / urgent / cold) from the per-ICP
cadence config in `config/profile.yml` (CLI flags override for one-off runs). JSON output.

---

## find-contacts *(planned stub)*

Phase 5: extract the decision-maker contact(s) for a qualified account via the Unipile / LinkedIn
Sales Navigator API, write them to the CRM `Contact` column and the account dossier. Degrades to
"no contact" when Sales Navigator is unavailable. A `purge-contacts` companion removes a contact or
account's PII from `prospects.md` / `prospects.db` / reports.
