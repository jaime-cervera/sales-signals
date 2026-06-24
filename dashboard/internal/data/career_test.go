package data

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseApplicationsSynthesizesRowNumbers(t *testing.T) {
	tempDir := t.TempDir()

	// CRM tracker: 8 columns by header NAME, no leading # column.
	prospects := `# Prospects Tracker

| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
|---------|--------|------------|----------|--------|---------|--------|-------|
| Arize AI | LLMOps Engineer ×2 | 2026-04-16 | 4.7/5 | Qualified | Jane Doe | [140](reports/140-arize-ai-2026-04-16.md) | Strong fit |
| Globex | AI Sales Engineer | 2026-04-16 | 4.1/5 | Contacted | — | [143](reports/143-globex-2026-04-16.md) | Good fit |
`

	prospectsPath := filepath.Join(tempDir, "prospects.md")
	if err := os.WriteFile(prospectsPath, []byte(prospects), 0o644); err != nil {
		t.Fatalf("failed to write prospects tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed accounts, got %d", len(apps))
	}

	// The CRM tracker has no per-row number column — Number is synthesized
	// from row order.
	if apps[0].Number != 1 {
		t.Fatalf("expected first account number to be 1, got %d", apps[0].Number)
	}
	if apps[1].Number != 2 {
		t.Fatalf("expected second account number to be 2, got %d", apps[1].Number)
	}
	// ReportNumber comes from the report link, not the row position.
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers from links, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
	// CRM columns map into the legacy field names.
	if apps[0].Company != "Arize AI" || apps[0].Role != "LLMOps Engineer ×2" {
		t.Fatalf("unexpected company/signal mapping: %q / %q", apps[0].Company, apps[0].Role)
	}
	if apps[0].Date != "2026-04-16" {
		t.Fatalf("expected SignalDate to map to Date, got %q", apps[0].Date)
	}
	if apps[0].Score != 4.7 || apps[0].ScoreRaw != "4.7/5" {
		t.Fatalf("expected ICPScore to map to Score/ScoreRaw, got %v / %q", apps[0].Score, apps[0].ScoreRaw)
	}
	if apps[0].Contact != "Jane Doe" {
		t.Fatalf("expected Contact column to map, got %q", apps[0].Contact)
	}
	if apps[0].Notes != "Strong fit" {
		t.Fatalf("expected Notes column to map, got %q", apps[0].Notes)
	}
}

func TestParseApplicationsMapsColumnsByHeaderName(t *testing.T) {
	tempDir := t.TempDir()

	// Columns intentionally reordered to prove parsing is by header NAME,
	// not by fixed position.
	prospects := `| Notes | Status | Company | Report | ICPScore | Signal | Contact | SignalDate |
|-------|--------|---------|--------|----------|--------|---------|------------|
| Reordered row | Opportunity | Acme | [7](reports/007-acme.md) | 3.9/5 | Platform Engineer | @acme_cto | 2026-06-03 |
`

	if err := os.WriteFile(filepath.Join(tempDir, "prospects.md"), []byte(prospects), 0o644); err != nil {
		t.Fatalf("failed to write prospects tracker: %v", err)
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 parsed account, got %d", len(apps))
	}
	a := apps[0]
	if a.Company != "Acme" {
		t.Fatalf("Company = %q, want Acme", a.Company)
	}
	if a.Role != "Platform Engineer" {
		t.Fatalf("Signal->Role = %q, want Platform Engineer", a.Role)
	}
	if a.Date != "2026-06-03" {
		t.Fatalf("SignalDate->Date = %q, want 2026-06-03", a.Date)
	}
	if a.Score != 3.9 {
		t.Fatalf("ICPScore->Score = %v, want 3.9", a.Score)
	}
	if a.Status != "Opportunity" {
		t.Fatalf("Status = %q, want Opportunity", a.Status)
	}
	if a.Contact != "@acme_cto" {
		t.Fatalf("Contact = %q, want @acme_cto", a.Contact)
	}
	if a.Notes != "Reordered row" {
		t.Fatalf("Notes = %q, want Reordered row", a.Notes)
	}
}

func TestParseApplicationsResolvesTrackerRelativeReportLinks(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	reportsDir := filepath.Join(tempDir, "reports")
	for _, dir := range []string{dataDir, reportsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	// Tracker links are written relative to the tracker file itself
	// (merge-tracker.mjs normalization): ../reports/... when the tracker
	// lives under data/. Legacy trackers may still carry root-relative
	// links; both must resolve to the same on-disk report. This exercises the
	// legacy data/applications.md fallback as well.
	applications := `# Prospects Tracker

| Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
|---------|--------|------------|----------|--------|---------|--------|-------|
| Acme | Engineer | 2026-06-03 | 4.0/5 | Qualified | — | [1](../reports/001-acme-2026-06-03.md) | Tracker-relative link |
| Legacy Co | Engineer | 2026-06-03 | 3.0/5 | New | — | [2](reports/002-legacy-2026-06-03.md) | Legacy root-relative link |
`

	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write prospects tracker: %v", err)
	}
	for _, name := range []string{"001-acme-2026-06-03.md", "002-legacy-2026-06-03.md"} {
		if err := os.WriteFile(filepath.Join(reportsDir, name), []byte("# Report\n"), 0o644); err != nil {
			t.Fatalf("failed to write report %s: %v", name, err)
		}
	}

	apps := ParseApplications(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed accounts, got %d", len(apps))
	}

	wantFirst := filepath.Join("reports", "001-acme-2026-06-03.md")
	if apps[0].ReportPath != wantFirst {
		t.Fatalf("expected tracker-relative link to resolve to %q, got %q", wantFirst, apps[0].ReportPath)
	}
	wantSecond := filepath.Join("reports", "002-legacy-2026-06-03.md")
	if apps[1].ReportPath != wantSecond {
		t.Fatalf("expected legacy root-relative link to resolve to %q, got %q", wantSecond, apps[1].ReportPath)
	}

	// Every consumer joins ReportPath against careerOpsPath — both rows
	// must point at files that exist.
	for i, app := range apps {
		if _, err := os.Stat(filepath.Join(tempDir, app.ReportPath)); err != nil {
			t.Fatalf("row %d: resolved report path %q does not exist: %v", i, app.ReportPath, err)
		}
	}
}

func TestNormalizeStatusUsesSalesStates(t *testing.T) {
	cases := map[string]string{
		"New":                 "new",
		"nuevo":               "new",
		"detected":            "new",
		"Qualified":           "qualified",
		"cualificado":         "qualified",
		"Contacted":           "contacted",
		"contactado":          "contacted",
		"outreach":            "contacted",
		"Replied":             "replied",
		"respondido":          "replied",
		"Meeting":             "meeting",
		"reunion":             "meeting",
		"demo":                "meeting",
		"Opportunity":         "opportunity",
		"oportunidad":         "opportunity",
		"opp":                 "opportunity",
		"Won":                 "won",
		"closed_won":          "won",
		"Lost":                "lost",
		"closed_lost":         "lost",
		"Disqualified":        "disqualified",
		"not_a_fit":           "disqualified",
		"skip":                "disqualified",
		"**Contacted** 2026-03-12": "contacted",
	}
	for raw, want := range cases {
		if got := NormalizeStatus(raw); got != want {
			t.Errorf("NormalizeStatus(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestStatusPriorityRanksOpportunityAboveTerminal(t *testing.T) {
	if StatusPriority("Opportunity") >= StatusPriority("New") {
		t.Fatalf("expected opportunity to outrank new")
	}
	if StatusPriority("New") >= StatusPriority("Lost") {
		t.Fatalf("expected active states to outrank terminal lost")
	}
	if StatusPriority("Lost") >= StatusPriority("Disqualified") {
		t.Fatalf("expected lost to rank above disqualified")
	}
}
