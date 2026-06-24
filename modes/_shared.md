# System Context -- Sales-Signals

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Don't put per-ICP data here.

     Per-ICP customization goes in icps/<slug>/icp.md (never auto-updated).
     This file contains system rules, the account-fit scoring logic, and tool
     config shared across all ICPs.
     ============================================================ -->

## Sources of Truth

Every data-touching action operates on the **active ICP** (set by
`bin/signals.mjs --icp <slug>`). Read these before scoring/qualifying:

| File | Path | When |
|------|------|------|
| vendor.yml | `config/vendor.yml` | ALWAYS (the seller: offering, default geo, Unipile account) |
| icp.md | `icps/<slug>/icp.md` | ALWAYS (the ICP definition: offering, firmographics, signal→need map, decision-makers, disqualifiers) |
| signals.yml | `icps/<slug>/signals.yml` | ALWAYS (the buying-signal role queries + filters) |
| scan-history.tsv | `icps/<slug>/scan-history.tsv` | For the repetition/sustained-hiring component |

**RULE: Read `icp.md` AFTER this file. Per-ICP customizations in `icp.md` override defaults here.**
**RULE: A buying signal = a company hiring the ICP's signal role. The thing being scored is the ACCOUNT (company), not a candidate.**

---

## Scoring System (account-fit)

Qualification scores each detected signal on **5 dimensions, 1-5**, rolled up to a
weighted **Global** account-fit score:

| Dimension | What it measures |
|-----------|-----------------|
| **ICP fit** | How well the account matches `icp.md` firmographics (industry, size, geography, stack) |
| **Signal strength / intent** | Strength of the buying signal: number of open signal roles, seniority of the hires (a Head/VP hire > one IC opening), repetition across scans. Anchored by `aggregate-signals.mjs` signalStrength |
| **Timing** | Recency of the signal (newest posting date) — fresher = stronger intent now |
| **Reachability** | Whether a decision-maker is findable/contactable (via Unipile Sales Navigator) |
| **Deal potential** | Estimated fit of the account's likely budget/need to the offering's value |
| **Global** | Weighted average (ICP fit + signal strength weighted highest) |

**Score interpretation:**
- 4.5+ → Strong account, qualify + extract contact + reach out now
- 4.0-4.4 → Good account, qualify + reach out
- 3.5-3.9 → Worth watching; reach out only with a specific angle
- Below 3.5 → Disqualify (no genuine signal or out of ICP)

## Signal Liveness (still-hiring check)

A qualitative check (does NOT change the 1-5 score): is the buying signal still
live? A closed/expired posting means the signal may have passed.

| Signal | Source | Notes |
|--------|--------|-------|
| Posting still open | Page snapshot / Unipile | Direct observable fact — expired ⇒ signal weakening |
| Signal recency | postedAt / SignalDate | Under 30d=hot, 30-90d=warm, 90d+=cooling |
| Reposting / multiple roles | scan-history.tsv | Same role reposted or several open roles = sustained, strong intent |
| Recent funding / growth news | WebSearch | Funding or expansion corroborates the buying need |
| Layoff / hiring-freeze news | WebSearch | A freeze can invalidate an apparent signal — note it |

**Framing:** present the signal evidence and let the user decide; never overstate intent.

## Signal → Need Taxonomy

Map the detected signal role to the inferred need, driven by the active `icp.md`
"Buying Signals → Need Mapping". Examples (the ICP's own mapping wins):

| Signal (role they're hiring) | Inferred need |
|------------------------------|---------------|
| LLMOps / ML Platform Engineer | Building production LLM systems → needs observability/evals |
| Data Platform / Analytics Engineer | Scaling data infra → needs pipeline reliability |
| Head of AI / VP Engineering | Standing up an AI function → budget + urgency present |

After detecting the signal→need, read `icps/<slug>/icp.md` for the ICP's specific
mapping, value proposition, and disqualifiers.

## Global Rules

### NEVER

1. Invent firmographics, signals, or metrics about an account
2. Overstate buying intent — present the evidence and let the user decide
3. Auto-send outreach on behalf of the user (the system drafts; the user sends)
4. Share personal phone numbers in generated messages
5. Score an account without reading the active `icp.md` first
6. Use corporate-speak
7. Ignore the CRM (every qualified account gets registered)

### ALWAYS

1. Read `config/vendor.yml`, the active `icps/<slug>/icp.md`, and `signals.yml` before scoring
2. Apply the ICP's signal→need mapping and disqualifiers per `icp.md`
3. Cite the concrete signal evidence (role, count, recency) when scoring
4. Use WebSearch for funding, news, and firmographic corroboration
5. Register the account in the CRM after qualifying
6. Generate outreach in the prospect's language (EN default)
7. Be direct and actionable -- no fluff
8. Native tech English for generated text. Short sentences, action verbs, no passive voice.
9. **Tracker additions as TSV** -- NEVER edit `prospects.md` directly. Write TSV in the active ICP's `tracker-additions/` (the launcher sets `CAREER_OPS_ADDITIONS`).
10. **Include `**URL:**` in every account dossier header.**

### Tools

| Tool | Use |
|------|-----|
| WebSearch | Firmographics, funding/news, decision-maker research, fallback for signals |
| WebFetch | Fallback for extracting postings from static pages |
| Playwright | Verify a signal is still live (browser_navigate + browser_snapshot). **NEVER 2+ agents with Playwright in parallel.** |
| Unipile | LinkedIn Jobs discovery + Sales Navigator decision-maker contacts |
| Read | `icp.md`, `signals.yml`, `vendor.yml`, scan-history.tsv |
| Write | account dossiers (reports .md), TSV tracker additions |
| Edit | Update the CRM |

### Speed-to-signal priority
- Live signal + decision-maker > exhaustive research
- Reach out sooner on a strong, fresh signal > over-analyze
- 80/20 approach, timebox everything
