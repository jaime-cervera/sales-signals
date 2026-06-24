# Customization Guide

Sales-Signals is designed to be customized by your AI coding CLI itself — just ask it to change
things. Below is the map of what lives where. The substance of each ICP is **user-layer**
(`icps/<slug>/`); the scoring engine and scripts are **system-layer** (see `DATA_CONTRACT.md`).

## Seller identity (config/vendor.yml)

The one seller. Set your company name, the offering every ICP buys, default geography, and the
Unipile `account_ref`. Secrets stay in `.env`.

## ICP definition (icps/<slug>/icp.md)

The heart of an ICP. The agent reads it when scoring and qualifying accounts. Key sections:

- **Offering** — what you sell to this ICP
- **Value proposition** — why this ICP buys it
- **Firmographics** — industry / company size / geography / tech stack you target
- **Buying signals → need mapping** — which hiring signals imply a need for the offering
- **Decision-makers** — the roles/titles you sell to
- **Disqualifiers** — what takes a company out of this ICP

Start from `templates/icp.template.md` (the scaffolder copies it for you).

## Buying-signal config (icps/<slug>/signals.yml)

Reuses a proven ATS-scanner config shape, repurposed as buying-signal queries (see
`templates/signals-schema.md`):

1. **title_filter.positive** — buying-signal role keywords (the roles a prospect hires that signal a need)
2. **title_filter.negative** — roles/tech to exclude
3. **location_filter** — `always_allow` / `allow` / `block` geos (optional)
4. **tracked_companies** — companies to check directly (ATS providers)
5. **search_queries** — WebSearch `site:` queries (Ashby, Greenhouse, Lever, …)
6. **unipile-jobs** — a `job_boards` entry for LinkedIn Jobs discovery

Validate with `node validate-signals.mjs --file icps/<slug>/signals.yml`.

## Account-fit scoring (modes/_shared.md)

The shared 5-dimension account-fit scoring system (ICP fit, signal strength/intent, timing,
reachability, deal potential). **Edit `_shared.md` only to change the shared defaults for every
ICP.** For ICP-specific weighting, put it in that ICP's `icp.md` instead.

## Follow-up cadence (icps/<slug>/config/profile.yml)

Optional per-ICP cadence settings for `followup-cadence.mjs` (contacted / replied / meeting
windows). CLI flags override for one-off runs.

## Sales states (templates/states.yml)

The canonical sales pipeline states (`New`, `Qualified`, `Contacted`, `Replied`, `Meeting`,
`Opportunity`, `Won`, `Lost`, `Disqualified`) and their aliases. They rarely need changing. If you
add a state, update in lockstep:

1. `templates/states.yml`
2. `normalize-statuses.mjs`, `verify-pipeline.mjs`, `merge-tracker.mjs`, `dedup-tracker.mjs`
3. `dashboard/internal/data/career.go`

(See the note at the top of `states.yml`: five places hardcode their own copy.)

## Hooks (optional)

Sales-Signals can integrate with external systems via Claude Code hooks. Save hooks in
`.claude/settings.json`. OpenCode does not support hooks — use custom commands
(`.opencode/commands/`) or agents (`.opencode/agents/`) instead.
