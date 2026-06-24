# Templates

System-layer template files used by Sales-Signals scripts and modes. These files are
auto-updated by system updates -- put user customizations in the user-layer files instead
(see DATA_CONTRACT.md).

## Files

| File | Used By | Purpose |
|------|---------|---------|
| `icp.template.md` | `scaffold-icp.mjs`, `icp` onboarding mode | ICP definition template (copied to `icps/<slug>/icp.md`) |
| `signals.example.yml` | Onboarding | Example buying-signal config (copied to `icps/<slug>/signals.yml`) |
| `signals-schema.md` | `validate-signals.mjs`, discovery modes | Locked single source of truth for the `signals.yml` shape |
| `crm-schema.md` | tracker writers/parsers + Go dashboard | Locked single source of truth for the `prospects.md` CRM column set |
| `states.yml` | `tracker.mjs`, `verify-pipeline.mjs`, `normalize-statuses.mjs`, `merge-tracker.mjs` | Canonical sales pipeline states and their aliases |

### icp.template.md

The ICP definition template materialized into each `icps/<slug>/icp.md`: offering, value
proposition, firmographics (industry/size/geo/stack), the buying-signal → need mapping,
decision-makers, and disqualifiers.

### signals.example.yml / signals-schema.md

`signals.yml` uses an ATS-scanner config structure (`title_filter.positive/negative`,
`location_filter`, `tracked_companies`, `search_queries`) repurposed as buying-signal role
keywords plus optional Unipile search params. `signals-schema.md` is the locked shape the
validator and the discovery modes read against so they cannot drift.

**To activate:** the `icp` onboarding mode (or `scaffold-icp.mjs`) copies
`signals.example.yml` into a new ICP as `signals.yml`; customize `title_filter.positive`
keywords for the buying-signal roles you want to detect.

### states.yml

Defines the canonical sales pipeline states (`New`, `Qualified`, `Contacted`, `Replied`,
`Meeting`, `Opportunity`, `Won`, `Lost`, `Disqualified`) with aliases for common variants.
All pipeline scripts and the dashboard validate statuses against this file.

**Do not rename states** -- the dashboard and all scripts depend on these exact IDs. You can
add aliases if you encounter new variants that should map to an existing state.
