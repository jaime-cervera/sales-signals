# Mode: qualify — Qualify a company's buying signal

Qualify ONE company (account) for the **active ICP**: score the buying signal,
infer the need, recommend the outreach angle + decision-maker, run the
still-hiring check, and write a dossier. Read `modes/_shared.md` first (the
account-fit scoring system).

## Inputs

- A company name / careers URL / a `pipeline.md` signal line for the active ICP.
- The active ICP's `icp.md` (definition) + `signals.yml` (signal roles) +
  `scan-history.tsv` (for repetition).

## Steps

1. **Account summary** — what the company does, size, geography, stack (WebSearch
   + the signal data). Match against `icp.md` firmographics.
2. **Signal analysis** — which signal role(s) they're hiring, how many, seniority
   mix, newest date, repetition across scans. Use `aggregate-signals.mjs`
   signalStrength as the anchor.
3. **Score the 5 dimensions (1-5)** per `_shared.md`: ICP fit, signal strength/
   intent, timing, reachability, deal potential → weighted **Global** account-fit.
4. **Signal → need** — infer the need from the ICP's "Buying Signals → Need
   Mapping"; state why this account likely needs the offering now.
5. **Recommended contact + angle** — the decision-maker title to reach (from
   `icp.md` Decision-Makers) and the outreach angle tying the signal to the value
   prop. (Contact extraction itself is the `contacts` mode / Phase 5.)
6. **Still-hiring check** (Signal Liveness in `_shared.md`) — is the posting still
   open / the signal still live? Verify with Playwright/Unipile; note funding or
   freeze news. Does NOT change the 1-5 score.
7. **Decision** — Qualified (≥3.5 and in-ICP) or Disqualified (no genuine signal /
   out of ICP). Recommend next action.

## Report

Reserve a number and write the dossier to the ICP's reports dir:

```bash
node bin/signals.mjs reserve-report --icp <slug>     # → e.g. 007
```
Save `icps/<slug>/reports/{NNN}-{company-slug}-{YYYY-MM-DD}.md`. Header MUST include:

```
# {NNN} — {Company}
**ICP:** {slug}
**Signal:** {role(s)} (×{count}, newest {date})
**ICPScore:** {X.X}/5
**Status:** {Qualified|Disqualified}
**Contact:** {decision-maker or "to extract"}
```

Then a `## Machine Summary` YAML block (company, signal, icp_score, status,
inferred_need, recommended_contact, next_action) for downstream scripts.

## Tracker

NEVER edit `prospects.md` directly. Write an **account TSV** addition to
`icps/<slug>/tracker-additions/{company-slug}.tsv` (8 cols, CRM order):

```
{company}\t{signal}\t{signaldate}\t{icpscore}/5\t{status}\t{contact}\t[{NNN}](reports/{NNN}-{slug}-{date}.md)\t{notes}
```

Then `node bin/signals.mjs merge --icp <slug>` folds it into the one account row
(append-only: status never downgrades, signals accumulate). If the high score
warrants it, offer to run the `contacts` mode to extract the decision-maker.

## Rules

- One row per account. Never auto-send outreach (the user sends).
- Operate only on the active ICP's files (isolation).
- A score < 3.5 or out-of-ICP ⇒ Disqualified, recorded (never deleted).
