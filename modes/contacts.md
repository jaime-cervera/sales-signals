# Mode: contacts — Extract decision-maker contacts (Unipile Sales Navigator)

For a **qualified account**, find the decision-maker(s) to reach and persist them
into the account's CRM row + dossier. Uses Unipile LinkedIn people search (Sales
Navigator preferred). Read `modes/_shared.md` first.

## When to run

- The `qualify` mode offers it when the ICP-fit score is high (≥ the vendor's
  `contact_extraction_min_score`), or on demand:

```bash
node bin/signals.mjs contacts --icp <slug> --account "<Company>" --titles "VP Engineering,Head of ML"
```

The target titles come from the active ICP's `icp.md` **Decision-Makers** section
(or `--titles`). The signal→need mapping informs which role to reach.

## What it does

1. Confirms Sales Navigator entitlement on the connected account (the value-floor
   gate) via `lib/unipile-client.mjs`.
2. Runs a people search scoped to the company + decision-maker titles; maps results
   to `{name, title, linkedinUrl, profileId}`; dedupes and picks the best per the
   ICP's target titles.
3. Writes the best contact into the account's `prospects.md` **Contact** column and
   a `## Contacts` section in the dossier.

## Rules (scope boundaries)

- **Never auto-message.** The system finds and drafts; the user sends.
- **Graceful degradation:** no Unipile creds / no Sales Navigator / zero matches →
  reports "no contact found" and **qualification stays usable** (exit 0, no crash).
  Respects 429 with backoff; keeps volume modest (LinkedIn ToS / account safety).
- **Secrets/PII:** the API key, DSN, and contact PII are never logged (redacted by
  the client). Decision-maker PII is stored only inside the per-ICP isolated stores.
- **Isolation:** operates only on the active ICP's files.

## GDPR purge (right to erasure)

Remove a contact or an account's contacts from the CRM + dossiers:

```bash
node bin/signals.mjs purge-contacts --icp <slug> --contact "<name|url|id>"
node bin/signals.mjs purge-contacts --icp <slug> --account "<Company>"
```

## Setup

Set in `.env` (gitignored; never commit): `UNIPILE_DSN`, `UNIPILE_API_KEY`,
`UNIPILE_ACCOUNT_ID` (see `.env.example`). The key is high-privilege — least
privilege, rotate on suspected leak, never log.
