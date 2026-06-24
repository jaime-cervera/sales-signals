# Mode: auto-pipeline — Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, execute the ENTIRE pipeline in sequence:

## Step 0 — Extract JD

If the input is a **URL** (not pasted JD text), follow this strategy to extract the content:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (last resort):** Search for the role title + company in secondary portals that index the JD in static HTML.

**If no method works:** Ask the user to paste the signal text manually or share a screenshot.

**If the input is JD text** (not a URL): use directly, without needing to fetch.

## Step 0.5 — Liveness gate

Before running any evaluation, confirm the posting is still live. The Step 0 Playwright snapshot already holds the evidence — judge it now, before spending tokens on the A-G evaluation, the report, or a PDF. A 404/expired page silently served as a static fallback ("position filled", empty shell) otherwise scores a full evaluation against phantom content.

1. From the Step 0 snapshot/fetched content, classify the posting:
   - **active posting evidence:** title/role + a real job description or an application/apply path
   - **closed posting evidence:** expired/closed/"no longer accepting applications", missing JD with only nav/footer, hard redirect to a generic careers/search page, or 404/410
2. If the posting appears closed or the page is a dead/fallback shell, **stop here**: do not run Step 1–Step 4. Tell the user the link is dead, and if the entry came from the active ICP's `pipeline.md`, mark it `- [x] ~~Company | Signal~~ — signal no longer active`.
3. If only JD text was pasted (no URL), there is no link to verify — skip the gate and proceed.

Do not continue to Step 1 until this gate is resolved.

## Step 1 — Account-fit Qualification

Execute the same as the `qualify` mode (read `modes/qualify.md` for the 5 account-fit
dimensions + the buying-signal → need mapping + Posting Legitimacy check). Score the
ACCOUNT (company), not a single job posting.

## Step 2 — Save Account Dossier .md

Save the full qualification in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (see format
in `modes/qualify.md`). Add **URL:** {url} and **Legitimacy:** {tier} to the dossier header.

## Step 3 — Update CRM

Record the account in the active ICP's CRM (`icps/<slug>/prospects.md`) via a TSV addition
in the active ICP's `tracker-additions/` (the launcher sets `CAREER_OPS_ADDITIONS`;
never edit `prospects.md` directly). Set `Status` to
`Qualified` (or `Disqualified` if it is not a fit), capture the `Signal`, `SignalDate`,
`ICPScore`, and a link to the dossier in `Report`.

**If any step fails**, continue with the next ones and mark the failed step as pending in the CRM.
