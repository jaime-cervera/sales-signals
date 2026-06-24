# Mode: followup -- Sales Follow-up Cadence Tracker

## Purpose

Track follow-up cadence for active accounts in the CRM pipeline. Flag accounts overdue for a next touch, extract decision-maker contacts, and generate tailored follow-up email/LinkedIn drafts using account-dossier context. Scoped to the **active ICP** (`icps/<slug>/prospects.md`).

## Inputs

- `icps/<slug>/prospects.md` — CRM tracker (set via `CAREER_OPS_TRACKER`)
- `data/follow-ups.md` — Follow-up touch history (created on first use; `CAREER_OPS_FOLLOWUPS`)
- `icps/<slug>/reports/` — Account dossiers (for context in drafts)
- `config/profile.yml` — Seller profile + optional cadence overrides (`CAREER_OPS_PROFILE`)

The tracker is the 8-column CRM table (columns mapped by **header NAME**, not position):

```
| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
```

## Step 1 — Run Cadence Script

Execute:

```bash
node followup-cadence.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Analysis date, total accounts, actionable count, overdue/urgent/cold/waiting counts |
| `entries` | Per-account: company, signal, status (sales stage), days since signal, follow-up count, urgency, next follow-up date, extracted contacts, report path |
| `cadenceConfig` | Cadence rules (windows per sales stage) |

If no actionable entries, tell the user:
> "No active accounts to follow up on. Contact some prospects first and come back when they're aging."

## Step 2 — Display Dashboard

Show a cadence dashboard sorted by urgency (urgent > overdue > waiting > cold):

```
Sales Follow-up Cadence Dashboard — {date}
{N} accounts tracked, {N} actionable

| Company | Status | Days | Follow-ups | Next | Urgency | Contact |
```

Use visual indicators:
- **URGENT** — respond within 24 hours (the prospect just **Replied**)
- **OVERDUE** — follow-up is past due
- **waiting (X days)** — on track, next touch scheduled
- **COLD** — max chases sent with no reply, suggest disqualifying

## Step 3 — Generate Follow-up Drafts

For each **overdue** or **urgent** entry only:

1. Read the linked account dossier (`reportPath` from JSON) for company/signal context
2. Read `config/vendor.yml` (the offering) and `config/profile.yml` (seller name/identity)
3. Tailor the draft to the **Signal** that triggered the account (the buying trigger)

### Cadence by sales stage

| Stage | What the follow-up does |
|-------|-------------------------|
| **Contacted** | Chase a non-reply. First window after outreach, then subsequent windows, capped (then COLD). |
| **Replied** | Move fast while the thread is warm — answer, qualify, propose a meeting. |
| **Meeting** | Post-meeting recap + concrete next step (proposal, trial, intro). |
| **Opportunity** | Deal-nudge cadence — keep momentum, remove blockers, drive to close. |
| **Won / Lost / Disqualified** | Terminal. No follow-up generated. |
| **New / Qualified** | Pre-outreach — not yet a follow-up; use the `contacto`/outreach flow first. |

### Contacted — first chase (followupCount == 0)

Generate a 3-4 sentence email:

1. **Sentence 1:** Reference the specific buying signal (the role/hire that triggered the account) and the company by name.
2. **Sentence 2:** One concrete value tie-in between the seller's offering (`vendor.yml`) and that signal. Quantify if possible.
3. **Sentence 3:** Soft ask + availability. Offer a specific window ("this week" or "next Tuesday").
4. **Sentence 4 (optional):** A relevant proof point or customer outcome.

**Rules:**
- Professional but warm, NOT pushy
- **NEVER** use "just checking in", "just following up", "touching base", or "circling back"
- Lead with value tied to the **signal**, not with the ask
- Keep under 150 words; include a subject line
- Use the seller's name from `config/profile.yml`

### Replied — warm-thread reply (urgent)

Respond fast (within the `replied_initial` window). Answer their question directly, qualify (budget/timeline/owner), and propose a concrete meeting time.

### Meeting — post-meeting follow-up

Send a recap within the `meeting_followup` window: what was agreed, the next step, and a deadline. Attach/reference anything promised in the meeting.

### Opportunity — deal nudge

On the `opportunity_nudge` cadence, send a momentum-keeping touch: surface a new proof point, remove a blocker, or confirm the next milestone toward close.

### Cold account (Contacted, followupCount >= contacted_max_followups)

Do NOT generate another chase. Instead suggest:
> "This account has had {N} chases with no reply. Consider:
> - Updating status to `Disqualified` if the signal has gone cold
> - Trying a different decision-maker contact
> - Leaving it in `Contacted` but deprioritizing"

## Step 4 — Present Drafts

For each draft, show:

```
## Follow-up: {Company} — {Signal}

**Stage:** {Contacted / Replied / Meeting / Opportunity}
**To:** {contact or "No contact found — run contact extraction first"}
**Subject:** {subject line}
**Days since signal:** {N}
**Follow-ups sent:** {N}
**Channel:** Email / LinkedIn

{draft text}
```

## Step 5 — Record Follow-ups

After the user confirms they've sent a follow-up, record it:

1. If `data/follow-ups.md` doesn't exist, create it (header-name mapped, company-keyed):
   ```markdown
   # Follow-up History

   | Company | Date | Channel | Contact | Notes |
   |---------|------|---------|---------|-------|
   ```

2. Append a row with:
   - `Company` = account name (the CRM key)
   - `Date` = today's date
   - `Channel` = Email / LinkedIn / Other
   - `Contact` = who it was sent to
   - `Notes` = brief note (e.g., "First chase, tied to LLMOps hiring signal")

3. Optionally update the Notes column in `prospects.md` with "Follow-up {N} sent {YYYY-MM-DD}"

**IMPORTANT:** Only record follow-ups the user confirms they actually sent. Never record a draft as sent.

## Step 6 — Summary

After showing all drafts, summarize:

> **Follow-up Dashboard** ({date})
> - {N} accounts being tracked
> - {N} overdue — drafts generated above
> - {N} urgent — respond today (warm replies)
> - {N} waiting — next touch dates shown
> - {N} cold — consider disqualifying
>
> Review the drafts above and tell me which ones you've sent so I can record them.

## Cadence Rules Reference (defaults)

| Stage | First touch | Subsequent | Cap |
|-------|-------------|------------|-----|
| Contacted | 4 days after outreach (no reply) | Every 4 days | 3 chases (then cold) |
| Replied | 1 day (warm reply) | Every 2 days | No limit |
| Meeting | 1 day after (recap / next step) | Every 1 day | No limit |
| Opportunity | 5 days (deal nudge) | Every 5 days | No limit |

Overrides live under `followup_cadence:` in `config/profile.yml`
(`contacted_first_days`, `contacted_subsequent_days`, `contacted_max_followups`,
`replied_initial_days`, `replied_subsequent_days`, `meeting_followup_days`,
`opportunity_nudge_days`), or via `node followup-cadence.mjs --contacted-days N`.
