# Agent-eval: account-fit scoring + qualify decision (Units 4.1, 4.2)

> Scripted agent-eval (golden score bands + decision). A deterministic test can't
> assert LLM scoring, so this fixes a (company + ICP) input with an expected
> per-dimension band and overall qualify decision. Run with an agent; assert the
> scores land in-band and the decision matches. The deterministic CRM mechanics
> (tracker write, append-only) are covered by `account-dedup-safety-tests.mjs`.

## ICP under test (`acme` — LLM observability)

- Offering: LLM observability & evaluation platform.
- Signal roles: LLMOps / ML Platform Engineer. Firmographics: Series A–C, 50–300, US/EU.
- Decision-makers: VP Eng, Head of ML. Disqualifier: pure research lab, no production product.

## Case 1 — strong fit (expect QUALIFIED)

**Input:** "Anthropic-like AI infra startup, ~150 people, US, hiring **3** roles
incl. a **Head of ML** and **2 LLMOps Engineers**, newest posting 4 days ago,
Series C, shipping a production LLM product."

| Dimension | Expected band (1-5) |
|-----------|---------------------|
| ICP fit | 4–5 (firmographics match) |
| Signal strength/intent | 4–5 (3 roles incl. exec, repeated) |
| Timing | 4–5 (4 days old) |
| Reachability | 3–5 (VP/Head titles findable on LinkedIn) |
| Deal potential | 4–5 |
| **Global** | **≥ 4.0** |

**Expected decision:** QUALIFIED. Recommended contact: VP Eng / Head of ML.
Inferred need: building production LLM systems → needs observability/evals.

## Case 2 — no genuine fit (expect DISQUALIFIED)

**Input:** "A 12-person academic research lab, no production product, hiring one
**Research Intern** in NLP, posting 120 days old."

| Dimension | Expected band (1-5) |
|-----------|---------------------|
| ICP fit | 1–2 (research lab, too small, no product) |
| Signal strength/intent | 1–2 (one Intern role; `negative` filter) |
| Timing | 1–2 (120 days old) |
| **Global** | **< 3.5** |

**Expected decision:** DISQUALIFIED (out of ICP + no genuine buying signal). Still
recorded in the CRM (never deleted).

## Pass/fail bar

PASS when Case 1 scores ≥4.0 Global → QUALIFIED with the right contact/need, and
Case 2 scores <3.5 Global → DISQUALIFIED. FAIL if a research-intern signal is
qualified, or a strong exec-led multi-role signal is disqualified.
