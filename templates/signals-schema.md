# `signals.yml` — Locked Schema (single source of truth)

> This is the **canonical shape** of a per-ICP `signals.yml`. The validator
> (`validate-signals.mjs`), the discovery engine (`scan.mjs` + providers), and the
> onboarding scaffolder all read against THIS document, so the schema cannot drift
> between them. It parallels `crm-schema.md` (the tracker column lock, Unit 4.3).
>
> `signals.yml` reuses a proven ATS-scanner config shape: the same title/location
> filtering and provider plumbing, reframed from "jobs I want" to "**buying-signal
> roles a prospect is hiring for**".

## Field groups

### `title_filter` (REQUIRED)

The buying-signal role keywords. A scanned job title is a signal when **≥1
`positive` matches AND 0 `negative` match** (case-insensitive substring).

| Key | Type | Required | Meaning |
|-----|------|----------|---------|
| `positive` | string[] | **yes — non-empty** | role keywords that indicate the buying signal (e.g. `"LLMOps"`, `"ML Platform"`) |
| `negative` | string[] | no | keywords that disqualify a title |
| `seniority_boost` | string[] | no | prefixes that raise signal strength (e.g. `"Head"`, `"Director"`) but are not required |

### `location_filter` (optional)

Geographic gating, applied AFTER the title filter. Absent ⇒ all locations pass.

| Key | Type | Meaning |
|-----|------|---------|
| `always_allow` | string[] | rescues multi-location postings naming your region (checked before `block`) |
| `allow` | string[] | if non-empty, a location must match at least one |
| `block` | string[] | locations to reject |

### `salary_filter` (optional)

Carried over unchanged from `portals.yml` (annualized `min`/`max`/`currency`).
Reframed as a deal-size proxy; absent ⇒ not filtered.

### `tracked_companies` (optional)

Known companies whose ATS board is checked directly (one entry = one employer).
Same shape as `portals.yml`: `name` (required when `enabled`), `careers_url`,
`api`, `provider` (must be a loaded provider id), `parser`, `enabled`.

### `job_boards` (optional)

Multi-employer sources (one entry = many employers in one fetch). Each has
`name`, `careers_url`, `provider` (a loaded provider id), `enabled`, `notes`.
**The Unipile LinkedIn Jobs discovery source is one `job_boards` entry with
`provider: unipile-jobs`** (its Unipile search params are documented in Unit 3.1
and validated here once added — no drift).

### `search_queries` (optional)

WebSearch complement queries (`name`, `query`, `enabled`) for companies off the
ATS/LinkedIn path. Reframed: each result is "a company showing the signal", not
"a job to apply to".

## Validation rules (enforced by `validate-signals.mjs`)

1. Root must be a YAML object.
2. `title_filter` must be present and `title_filter.positive` must be a non-empty
   list of non-empty strings (an ICP with no positive signal keyword is useless).
3. `title_filter.{positive,negative,seniority_boost}`, `location_filter.*` lists
   must contain only non-empty strings.
4. `search_queries`, `tracked_companies`, `job_boards` must be arrays when present.
5. Each enabled `tracked_companies` / `job_boards` entry must have a non-empty
   `name`; URLs must be valid http(s); a named `provider` must be a loaded
   provider id.
6. At least one discovery source should exist (`tracked_companies`, `job_boards`,
   or `search_queries`) — a warning, not an error (a filter-only ICP is allowed
   while sources are configured).
