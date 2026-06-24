# Mode: deep — Deep Account Research Prompt

Generate a structured prompt for Perplexity/Claude/ChatGPT to research a **prospect company (account)** before qualifying or reaching out. Six axes:

```text
## Deep Account Research: [Company] — [Buying Signal]

Context: I sell [our offering, from config/vendor.yml + the active icp.md]. [Company] is
showing a buying signal ([the signal role they're hiring / event detected]). I need
actionable intelligence to qualify this account and tailor outreach.

### 1. Buying signal & need
- What roles are they hiring that imply a need for our service?
- How many open roles, what seniority, how recently posted?
- What does the signal imply they are building or scaling right now?
- Any public statements about the initiative behind the hiring?

### 2. Recent moves (last 6 months)
- Funding rounds, leadership changes, reorgs?
- Acquisitions, partnerships, or new market entries?
- Product launches or strategic pivots?
- Expansion or, conversely, layoffs / hiring freezes (which can invalidate the signal)?

### 3. Firmographics & fit
- Industry, company size, geography, and tech stack.
- How well does this match our ICP firmographics (read from icps/<slug>/icp.md)?
- Any disqualifiers from the ICP definition present?

### 4. Likely pain points
- What scaling, reliability, cost, or compliance problems does the signal imply?
- What are they migrating or standing up that our offering addresses?
- What pain points do employees/customers mention publicly?

### 5. Competitors, incumbents & differentiation
- Who are their main competitors?
- What tools/vendors are they likely already using in our category?
- Where could we displace or complement an incumbent?

### 6. Decision-makers & reachability
- Who owns the budget/initiative tied to this signal (title, team)?
- Are they findable/contactable (LinkedIn / Sales Navigator via Unipile)?
- What angle or value proposition (from icp.md) would land with that persona?
```

Personalize each section with the specific context of the account and the active ICP's
signal→need mapping (read `icps/<slug>/icp.md`).
