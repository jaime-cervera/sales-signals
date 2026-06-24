# Mode: icp — Onboard a new ICP (buying-signal profile)

You are onboarding a new **ICP** (Ideal Customer Profile) for Sales-Signals. One
ICP = one buying-signal hypothesis: "a company hiring **{signal role}** needs
**{our offering}**." Each ICP is isolated under `icps/<slug>/` with its own
signals, pipeline, and CRM.

## When this runs

- `bin/signals.mjs icp --icp <slug>` (interactive onboarding), or
- the launcher created the ICP on the fly via `bin/signals.mjs <cmd> --icp <slug> --create-icp`.

## Step 0 — Vendor (once)

If `config/vendor.yml` is missing, copy it from `config/vendor.example.yml` and
capture the **seller**: company name, the one offering every ICP buys, website,
default geography, and whether the connected LinkedIn account has Sales Navigator.

## Step 1 — Capture the ICP (conversational)

Ask the user for, and confirm:

1. **A short name** for this ICP (e.g. "AI infra startups"). Derive a kebab
   **slug** from it (lowercase, hyphens) — this is the `icps/<slug>/` directory.
2. **Offering & value prop** — what you sell to this ICP and the outcome they get.
3. **Firmographics** — industry, company size, geography, tech-stack/context that
   make a good-fit account.
4. **Buying-signal roles** — the job titles a prospect hiring for would signal the
   need (e.g. "LLMOps Engineer", "ML Platform Engineer"). These become
   `title_filter.positive`. Capture negatives + seniority boosts too.
5. **Signal → need mapping** — for each signal role, the inferred need and why.
6. **Decision-maker titles** — who to contact once qualified (used by the
   `contacts` mode / Unipile Sales Navigator).
7. **Disqualifiers** — traits that make an account NOT a fit despite the signal.

## Step 2 — Scaffold

Create the ICP directory from templates (idempotent; refuses to clobber an
existing slug without `--force`):

```bash
node scaffold-icp.mjs --slug <slug>
```

This writes `icps/<slug>/` with a starter signals config (`signals.yml`), an ICP
definition (`icp.md`), an empty pipeline (`pipeline.md`), an empty CRM tracker
(`prospects.md` with the CRM header), and `scan-history.tsv`.

## Step 3 — Fill in the captured details

Edit the scaffolded files with what you captured in Step 1:

- **`icps/<slug>/signals.yml`** — set `title_filter.positive` to the buying-signal
  role keywords, plus negatives, seniority boosts, and a `location_filter` if the
  ICP is geo-bound. Add any known `tracked_companies` / `search_queries` /
  a `unipile-jobs` `job_boards` entry.
- **`icps/<slug>/icp.md`** — fill the ICP definition sections
  (Offering, Value Proposition, Firmographics, Buying Signals → Need Mapping,
  Decision-Makers, Disqualifiers), replacing the `{{PLACEHOLDER}}` tokens.

## Step 4 — Validate & confirm

```bash
node validate-signals.mjs --file icps/<slug>/signals.yml --icp-file icps/<slug>/icp.md
```

Fix any reported errors (e.g. empty `title_filter.positive`). Then confirm the
ICP is ready:

> "ICP **<slug>** is set up. Discover prospects with
> `node bin/signals.mjs scan --icp <slug>`."

## Rules

- Never write one ICP's data into another's directory (isolation invariant).
- The slug is validated (kebab only) — a typo never escapes `icps/`.
- A new ICP's user-data files are already covered by `.gitignore` — never commit
  prospect PII.
