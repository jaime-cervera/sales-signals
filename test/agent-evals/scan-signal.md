# Agent-eval: `scan` buying-signal decision (Unit 3.2)

> Scripted agent-eval fixture (golden decisions) for the WebSearch complement of
> `modes/scan.md`. A deterministic test can't assert LLM behaviour, so this fixes a
> small set of candidate companies (with/without the signal role) and the expected
> "signal present / absent" decision. Run with an agent and assert the decisions match.

## ICP under test

- **Signal role(s):** `title_filter.positive = ["LLMOps", "ML Platform"]`, `negative = ["Intern"]`.

## Candidate companies (fixed input)

| Company | Hiring (title from WebSearch) | Expected decision |
|---------|-------------------------------|-------------------|
| Acme | "LLMOps Engineer" | **signal PRESENT** (positive match, no negative) |
| Globex | "Senior ML Platform Engineer" | **signal PRESENT** (positive match; seniority boost) |
| Initech | "Frontend Engineer" | **signal ABSENT** (no positive match) |
| Umbrella | "LLMOps Intern" | **signal ABSENT** (negative "Intern" present) |
| Hooli | "Head of ML Platform" | **signal PRESENT** (positive match; exec → high seniority weight) |

## Expected behaviour

- Companies with a signal PRESENT are added to the ICP pipeline, **company-grouped**
  with a signal strength; Hooli (exec) and Globex (senior) outrank Acme (IC) at equal count.
- Companies with a signal ABSENT are recorded in `scan-history.tsv` as `skipped_title`
  and NOT added to the pipeline.
- A pasted-but-expired URL (Level-3) is verified via Playwright and dropped as `skipped_expired`.
- All writes are scoped to the active ICP (`icps/<slug>/`), never another ICP.

## Pass/fail bar

PASS when the present/absent decisions match the table and pipeline output is
company-grouped. FAIL on any misclassification (e.g. adding the Intern role, or
dropping a valid LLMOps signal).
