# Agent-eval: `icp` onboarding mode (Unit 2.3)

> Scripted agent-eval fixture (golden transcript). A deterministic `*-tests.mjs`
> cannot assert LLM behaviour, so this fixture is the behavioural spec for the
> `icp` mode: a fixed input transcript + the expected ICP output. Run it with an
> agent (CI-with-agent or manual) and assert the output matches the golden
> expectations below. The deterministic half (scaffolding, validation, isolation)
> is covered by `scaffold-icp-tests.mjs` + `validate-icp-tests.mjs`.

## Input (fixed onboarding transcript)

> User: I sell an LLM observability platform. I want to target AI-infra startups
> that are clearly building LLM systems. They're usually Series A–C, 50–300 people,
> US or Europe. The tell is they're hiring an LLMOps or ML Platform engineer.
> The people I'd reach out to are the VP Eng or Head of ML. Skip pure research
> labs with no production product.

## Expected output (golden assertions)

After running `modes/icp.md` against the transcript, the produced ICP MUST satisfy:

### `icps/ai-infra/portals.yml` (signals)
- `title_filter.positive` contains **"LLMOps"** and **"ML Platform"** (the signal roles).
- `title_filter.seniority_boost` includes Head / Director / VP-style boosts.
- `location_filter.allow` includes the US and Europe (or `always_allow` names them).
- validates with `node validate-signals.mjs --file icps/ai-infra/portals.yml` → **0 errors**.

### `icps/ai-infra/modes/_profile.md` (ICP definition)
- **Offering** section mentions LLM observability.
- **Firmographics** captures: Series A–C, 50–300 people, US/Europe.
- **Buying Signals → Need Mapping** maps "LLMOps / ML Platform hire" → "building
  production LLM systems → needs observability".
- **Decision-Makers** lists VP Eng and Head of ML.
- **Disqualifiers** excludes pure research labs without a production product.
- `validateIcpMarkdown` reports **0 missing sections**.

### Behaviour
- A kebab slug (e.g. `ai-infra`) is derived and `icps/ai-infra/` is created via
  `scaffold-icp.mjs` (no clobber of an existing ICP).
- No file outside `icps/ai-infra/` is written (isolation).

## Pass/fail bar

PASS when all golden assertions above hold. FAIL if any signal role is missing,
the ICP definition omits a required section, or the validator reports errors.
