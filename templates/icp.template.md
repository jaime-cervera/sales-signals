# ICP: {{ICP_NAME}}

> One ICP (Ideal Customer Profile) = one buying-signal hypothesis: "a company
> hiring **{{SIGNAL_ROLE}}** needs **{{OUR_OFFERING}}**." This file is the ICP's
> definition. The agent reads it when scoring and qualifying accounts for this ICP.

## Offering

<!-- What we sell to this ICP, in one or two sentences. -->
{{WHAT_WE_SELL}}

## Value Proposition

<!-- The outcome the prospect gets. Why the signal role implies they need us. -->
{{VALUE_PROP}}

## Firmographics

<!-- The shape of a good-fit account. Used by the ICP-fit scoring dimension. -->
- **Industry:** {{INDUSTRY}}
- **Company size:** {{SIZE}}
- **Geography:** {{GEOGRAPHY}}
- **Tech stack / context:** {{STACK}}

## Buying Signals → Need Mapping

<!-- The core of the ICP: which hiring signal maps to which inferred need. The
     signal roles here MUST align with signals.yml title_filter.positive. -->
| Signal (role they're hiring) | Inferred need | Why it maps |
|------------------------------|---------------|-------------|
| {{SIGNAL_ROLE}} | {{INFERRED_NEED}} | {{RATIONALE}} |

## Decision-Makers (who to contact)

<!-- Target titles for contact extraction (Unipile Sales Navigator, Phase 5). -->
- {{TARGET_TITLE_1}}
- {{TARGET_TITLE_2}}

## Disqualifiers

<!-- Account traits that make this NOT a fit, even with the signal present. -->
- {{DISQUALIFIER}}
