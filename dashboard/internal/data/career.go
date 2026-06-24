package data

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var (
	reReportLink     = regexp.MustCompile(`\[(\d+)\]\(([^)]+)\)`)
	reScoreValue     = regexp.MustCompile(`(\d+\.?\d*)/5`)
	reArchetype      = regexp.MustCompile(`(?i)\*\*Arquetipo(?:\s+detectado)?\*\*\s*\|\s*(.+)`)
	reTlDr           = regexp.MustCompile(`(?i)\*\*TL;DR\*\*\s*\|\s*(.+)`)
	reTlDrColon      = regexp.MustCompile(`(?i)\*\*TL;DR:\*\*\s*(.+)`)
	reRemote         = regexp.MustCompile(`(?i)\*\*Remote\*\*\s*\|\s*(.+)`)
	reComp           = regexp.MustCompile(`(?i)\*\*Comp\*\*\s*\|\s*(.+)`)
	reArchetypeColon = regexp.MustCompile(`(?i)\*\*Arquetipo:\*\*\s*(.+)`)
	reReportURL      = regexp.MustCompile(`(?m)^\*\*URL:\*\*\s*(https?://\S+)`)
	reBatchID        = regexp.MustCompile(`(?m)^\*\*Batch ID:\*\*\s*(\d+)`)
)

// resolveReportPath converts a report link from the tracker into a path
// relative to careerOpsPath. Links are normally relative to the tracker
// file's own directory (see merge-tracker.mjs link normalization, #760);
// legacy trackers may still carry root-relative links, so fall back to the
// raw link when the tracker-relative resolution does not exist on disk.
func resolveReportPath(careerOpsPath, trackerPath, link string) string {
	resolved := filepath.Join(filepath.Dir(trackerPath), link)
	if _, err := os.Stat(resolved); err != nil {
		legacy := filepath.Join(careerOpsPath, link)
		if _, err2 := os.Stat(legacy); err2 == nil {
			resolved = legacy
		}
	}
	if rel, err := filepath.Rel(careerOpsPath, resolved); err == nil {
		return rel
	}
	return link
}

// splitTableRow splits a markdown table row into trimmed cell values. It keeps
// the legacy tab-aware branch (mixed "| " then tab-separated layout) alongside
// the pure pipe format.
func splitTableRow(line string) []string {
	var fields []string
	if strings.Contains(line, "\t") {
		// Mixed format: starts with "| " then tab-separated
		line = strings.TrimPrefix(line, "|")
		line = strings.TrimSpace(line)
		for _, p := range strings.Split(line, "\t") {
			fields = append(fields, strings.TrimSpace(strings.Trim(p, "|")))
		}
	} else {
		// Pure pipe format
		line = strings.Trim(line, "|")
		for _, p := range strings.Split(line, "|") {
			fields = append(fields, strings.TrimSpace(p))
		}
	}
	return fields
}

// looksLikeHeader reports whether a table row is the CRM header. The canonical
// header starts with "Company", but it may be column-reordered, so we accept any
// row that contains "Company" plus at least one other known CRM column name.
func looksLikeHeader(fields []string) bool {
	known := map[string]bool{
		"company": true, "signal": true, "signaldate": true, "icpscore": true,
		"status": true, "contact": true, "report": true, "notes": true,
	}
	hasCompany := false
	others := 0
	for _, f := range fields {
		name := strings.ToLower(strings.TrimSpace(f))
		if name == "company" {
			hasCompany = true
		} else if known[name] {
			others++
		}
	}
	return hasCompany && others >= 1
}

// cell returns the value for the named CRM column (case-insensitive) using the
// header->index map, or "" when the column is absent / the row is too short.
func cell(fields []string, header map[string]int, name string) string {
	idx, ok := header[name]
	if !ok || idx < 0 || idx >= len(fields) {
		return ""
	}
	return fields[idx]
}

// ParseApplications reads the CRM tracker (prospects.md) and returns parsed rows.
// It tries {path}/prospects.md, then the legacy {path}/data/applications.md and
// {path}/applications.md fallbacks for compatibility. Columns are mapped by
// header NAME (not fixed position): Company, Signal, SignalDate, ICPScore,
// Status, Contact, Report, Notes.
func ParseApplications(careerOpsPath string) []model.CareerApplication {
	filePath := filepath.Join(careerOpsPath, "prospects.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		// Legacy fallback: data/ subdirectory
		filePath = filepath.Join(careerOpsPath, "data", "applications.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			// Legacy fallback: root applications.md
			filePath = filepath.Join(careerOpsPath, "applications.md")
			content, err = os.ReadFile(filePath)
			if err != nil {
				return nil
			}
		}
	}

	lines := strings.Split(string(content), "\n")
	apps := make([]model.CareerApplication, 0)
	num := 0

	// header maps a CRM column name (lowercased) to its column index. It is
	// built from the first table row whose first cell is "Company" (the CRM
	// header), so all data access is positional-by-name, never fixed position.
	var header map[string]int

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "# ") || strings.HasPrefix(line, "|---") {
			continue
		}
		if !strings.HasPrefix(line, "|") {
			continue
		}

		fields := splitTableRow(line)
		if len(fields) == 0 {
			continue
		}

		// Header row: detected by its CRM column names (the canonical header's
		// first cell is "Company"). Build the name->index map and skip the row
		// itself. Do NOT rely on a numeric first column.
		if header == nil && looksLikeHeader(fields) {
			header = make(map[string]int, len(fields))
			for i, f := range fields {
				header[strings.ToLower(strings.TrimSpace(f))] = i
			}
			continue
		}

		// Until a header row is seen, fall back to the canonical CRM order so a
		// tracker without a recognizable header still parses deterministically.
		if header == nil {
			header = map[string]int{
				"company": 0, "signal": 1, "signaldate": 2, "icpscore": 3,
				"status": 4, "contact": 5, "report": 6, "notes": 7,
			}
		}

		if len(fields) < 8 {
			continue
		}

		num++
		app := model.CareerApplication{
			Number:  num,
			Date:    cell(fields, header, "signaldate"),
			Company: cell(fields, header, "company"),
			Role:    cell(fields, header, "signal"),
			Status:  cell(fields, header, "status"),
			Contact: cell(fields, header, "contact"),
		}

		// Parse score from the ICPScore column ("X.X/5").
		scoreRaw := cell(fields, header, "icpscore")
		app.ScoreRaw = scoreRaw
		if sm := reScoreValue.FindStringSubmatch(scoreRaw); sm != nil {
			app.Score, _ = strconv.ParseFloat(sm[1], 64)
		}

		// Parse report link. Tracker links are written relative to the
		// tracker file itself (e.g. ../reports/... when the tracker lives in
		// data/), so resolve against the tracker's directory and normalize
		// back to a careerOpsPath-relative path, which is what every
		// consumer joins against. Legacy root-relative links are kept as a
		// fallback when the resolved file does not exist. The CRM tracker has
		// no per-row number column, so ReportNumber is synthesized from the
		// report link when present.
		if rm := reReportLink.FindStringSubmatch(cell(fields, header, "report")); rm != nil {
			app.ReportNumber = rm[1]
			app.ReportPath = resolveReportPath(careerOpsPath, filePath, rm[2])
		}

		app.Notes = cell(fields, header, "notes")

		// Lift location / work mode / pay / last-contact out of the notes free-text
		deriveNoteFields(&app)

		apps = append(apps, app)
	}

	// Enrich with job URLs using 5-tier strategy:
	// 1. **URL:** field in report header (newest reports)
	// 2. **Batch ID:** in report -> batch-input.tsv URL lookup
	// 3. report_num -> batch-state completed mapping (legacy)
	// 4. scan-history.tsv (pipeline scan entries matched by company+role)
	// 5. company name fallback from batch-input.tsv
	batchURLs := loadBatchInputURLs(careerOpsPath)
	reportNumURLs := loadJobURLs(careerOpsPath)

	for i := range apps {
		if apps[i].ReportPath == "" {
			continue
		}
		fullReport := filepath.Join(careerOpsPath, apps[i].ReportPath)
		reportContent, err := os.ReadFile(fullReport)
		if err != nil {
			continue
		}
		header := string(reportContent)
		// Only scan the header (first 1000 bytes) for speed
		if len(header) > 1000 {
			header = header[:1000]
		}

		// Strategy 1: **URL:** in report
		if m := reReportURL.FindStringSubmatch(header); m != nil {
			apps[i].JobURL = m[1]
			continue
		}

		// Strategy 2: **Batch ID:** -> batch-input.tsv
		if m := reBatchID.FindStringSubmatch(header); m != nil {
			if url, ok := batchURLs[m[1]]; ok {
				apps[i].JobURL = url
				continue
			}
		}

		// Strategy 3: report_num -> batch-state completed mapping
		if reportNumURLs != nil {
			if url, ok := reportNumURLs[apps[i].ReportNumber]; ok {
				apps[i].JobURL = url
				continue
			}
		}
	}

	// Strategy 4: scan-history.tsv (pipeline scan entries matched by company+role)
	enrichFromScanHistory(careerOpsPath, apps)

	// Strategy 5: company name fallback from batch-input.tsv
	enrichAppURLsByCompany(careerOpsPath, apps)

	return apps
}

// loadBatchInputURLs reads batch-input.tsv and returns a map of batch ID -> job URL.
func loadBatchInputURLs(careerOpsPath string) map[string]string {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}
	result := make(map[string]string)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		notes := fields[3]
		// Extract real job URL from notes: "Title @ Company | Match% | https://actual-url"
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				result[id] = u
				continue
			}
		}
		// Fallback: use JackJill URL
		if strings.HasPrefix(fields[1], "http") {
			result[id] = fields[1]
		}
	}
	return result
}

// batchEntry holds parsed data from batch-input.tsv.
type batchEntry struct {
	id      string
	url     string
	company string
	role    string
}

// loadJobURLs reads batch TSV files and returns a map of report_num -> job URL.
// Uses two strategies: (1) report_num mapping for completed jobs, (2) company name
// matching as fallback for failed/missing jobs.
func loadJobURLs(careerOpsPath string) map[string]string {
	// Read batch-input.tsv: id \t url \t source \t notes
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}

	// Parse batch-input: extract job URL, company, and role from notes
	entries := make(map[string]batchEntry) // keyed by id
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		e := batchEntry{id: fields[0]}
		notes := fields[3]

		// Extract URL from notes: "Title @ Company | Match% | https://actual-url"
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				e.url = u
			}
		}
		// Fallback: use JackJill URL from field 1
		if e.url == "" && strings.HasPrefix(fields[1], "http") {
			e.url = fields[1]
		}

		// Extract company and role: "Role @ Company | Match% | URL"
		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			e.role = strings.TrimSpace(notesPart[:atIdx])
			e.company = strings.TrimSpace(notesPart[atIdx+3:])
		}

		if e.url != "" {
			entries[fields[0]] = e
		}
	}

	// Read batch-state.tsv: id \t url \t status \t ... \t report_num \t ...
	statePath := filepath.Join(careerOpsPath, "batch", "batch-state.tsv")
	stateData, err := os.ReadFile(statePath)
	if err != nil {
		return nil
	}

	// Strategy 1: map report_num -> URL only for COMPLETED jobs
	reportToURL := make(map[string]string)
	for _, line := range strings.Split(string(stateData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 6 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		status := fields[2]
		reportNum := fields[5]
		if status != "completed" || reportNum == "" || reportNum == "-" {
			continue
		}
		if e, ok := entries[id]; ok {
			reportToURL[reportNum] = e.url
			if len(reportNum) < 3 {
				reportToURL[fmt.Sprintf("%03s", reportNum)] = e.url
			}
		}
	}

	return reportToURL
}

// enrichFromScanHistory fills JobURL from scan-history.tsv by matching company name.
func enrichFromScanHistory(careerOpsPath string, apps []model.CareerApplication) {
	scanPath := filepath.Join(careerOpsPath, "scan-history.tsv")
	scanData, err := os.ReadFile(scanPath)
	if err != nil {
		return
	}

	// Build company -> URL index from scan-history
	type scanEntry struct {
		url     string
		company string
		title   string
	}
	byCompany := make(map[string][]scanEntry)
	for _, line := range strings.Split(string(scanData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 5 || fields[0] == "url" {
			continue
		}
		url := fields[0]
		company := fields[4]
		title := fields[3]
		if url == "" || !strings.HasPrefix(url, "http") {
			continue
		}
		key := normalizeCompany(company)
		byCompany[key] = append(byCompany[key], scanEntry{url: url, company: company, title: title})
	}

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		key := normalizeCompany(apps[i].Company)
		matches := byCompany[key]
		if len(matches) == 1 {
			apps[i].JobURL = matches[0].url
		} else if len(matches) > 1 {
			// Multiple entries: pick best role match
			appRole := strings.ToLower(apps[i].Role)
			best := matches[0].url
			bestScore := 0
			for _, m := range matches {
				score := 0
				mTitle := strings.ToLower(m.title)
				for _, word := range strings.Fields(appRole) {
					if len(word) > 2 && strings.Contains(mTitle, word) {
						score++
					}
				}
				if score > bestScore {
					bestScore = score
					best = m.url
				}
			}
			apps[i].JobURL = best
		}
	}
}

// normalizeCompany strips common suffixes and lowercases a company name.
func normalizeCompany(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	for _, suffix := range []string{" inc.", " inc", " llc", " ltd", " corp", " corporation", " technologies", " technology", " group", " co."} {
		s = strings.TrimSuffix(s, suffix)
	}
	return strings.TrimSpace(s)
}

// enrichAppURLsByCompany fills in JobURL for apps that didn't get one via report_num mapping.
// It matches by company name from batch-input.tsv notes.
func enrichAppURLsByCompany(careerOpsPath string, apps []model.CareerApplication) {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return
	}

	// Build company -> []entry index
	type entry struct {
		role string
		url  string
	}
	byCompany := make(map[string][]entry)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		notes := fields[3]
		var url string
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				url = u
			}
		}
		if url == "" && strings.HasPrefix(fields[1], "http") {
			url = fields[1]
		}
		if url == "" {
			continue
		}
		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			role := strings.TrimSpace(notesPart[:atIdx])
			company := strings.TrimSpace(notesPart[atIdx+3:])
			key := normalizeCompany(company)
			byCompany[key] = append(byCompany[key], entry{role: role, url: url})
		}
	}

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		key := normalizeCompany(apps[i].Company)
		matches := byCompany[key]
		if len(matches) == 1 {
			apps[i].JobURL = matches[0].url
		} else if len(matches) > 1 {
			// Multiple entries for same company: pick best role match
			appRole := strings.ToLower(apps[i].Role)
			best := matches[0].url
			bestScore := 0
			for _, m := range matches {
				score := 0
				mRole := strings.ToLower(m.role)
				// Count matching words
				for _, word := range strings.Fields(appRole) {
					if len(word) > 2 && strings.Contains(mRole, word) {
						score++
					}
				}
				if score > bestScore {
					bestScore = score
					best = m.url
				}
			}
			apps[i].JobURL = best
		}
	}
}

// ComputeMetrics calculates aggregate metrics from applications.
func ComputeMetrics(apps []model.CareerApplication) model.PipelineMetrics {
	m := model.PipelineMetrics{
		Total:    len(apps),
		ByStatus: make(map[string]int),
	}

	var totalScore float64
	var scored int

	for _, app := range apps {
		status := NormalizeStatus(app.Status)
		m.ByStatus[status]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > m.TopScore {
				m.TopScore = app.Score
			}
		}
		if app.HasPDF {
			m.WithPDF++
		}
		// Lost / disqualified are the terminal, non-actionable sales states.
		if status != "lost" && status != "disqualified" {
			m.Actionable++
		}
	}

	if scored > 0 {
		m.AvgScore = totalScore / float64(scored)
	}

	return m
}

// NormalizeStatus normalizes raw status text to a canonical sales state.
// Canonical ids + aliases match states.yml -- this is the 6th hardcoded copy
// of those states and MUST be kept in lockstep with templates/states.yml.
// Returns one of: new, qualified, contacted, replied, meeting, opportunity,
// won, lost, disqualified.
func NormalizeStatus(raw string) string {
	// Strip markdown bold and trailing dates
	s := strings.ReplaceAll(raw, "**", "")
	s = strings.TrimSpace(strings.ToLower(s))
	// Strip trailing date (e.g., "contacted 2026-03-12")
	if idx := strings.Index(s, " 202"); idx > 0 {
		s = strings.TrimSpace(s[:idx])
	}

	switch {
	// Most restrictive first — terminal states, then accept English/Spanish
	// labels and the states.yml aliases.
	case strings.Contains(s, "disqualif") || strings.Contains(s, "descalificado") ||
		strings.Contains(s, "not_a_fit") || strings.Contains(s, "not a fit") ||
		strings.Contains(s, "no_fit") || strings.Contains(s, "no fit") || s == "skip":
		return "disqualified"
	case strings.Contains(s, "lost") || strings.Contains(s, "perdido") || strings.Contains(s, "closed_lost"):
		return "lost"
	case strings.Contains(s, "won") || strings.Contains(s, "ganado") || strings.Contains(s, "closed_won") || s == "customer":
		return "won"
	case strings.Contains(s, "opportunity") || strings.Contains(s, "oportunidad") || s == "deal" || s == "opp":
		return "opportunity"
	case strings.Contains(s, "meeting") || strings.Contains(s, "reunion") || s == "demo":
		return "meeting"
	case strings.Contains(s, "replied") || strings.Contains(s, "respondido") || strings.Contains(s, "responded"):
		return "replied"
	case strings.Contains(s, "contacted") || strings.Contains(s, "contactado") || strings.Contains(s, "outreach") || strings.Contains(s, "reached_out") || strings.Contains(s, "reached out"):
		return "contacted"
	case strings.Contains(s, "qualified") || strings.Contains(s, "cualificado") || s == "qualify":
		return "qualified"
	case strings.Contains(s, "new") || strings.Contains(s, "nuevo") || s == "detected" || s == "signal":
		return "new"
	default:
		return s
	}
}

// LoadReportSummary extracts key fields from a report file.
func LoadReportSummary(careerOpsPath, reportPath string) (archetype, tldr, remote, comp string) {
	fullPath := filepath.Join(careerOpsPath, reportPath)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return
	}
	text := string(content)

	if m := reArchetype.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	} else if m := reArchetypeColon.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	}

	// Try table-format TL;DR first (most reports), then colon format
	if m := reTlDr.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	} else if m := reTlDrColon.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	}

	if m := reRemote.FindStringSubmatch(text); m != nil {
		remote = cleanTableCell(m[1])
	}

	if m := reComp.FindStringSubmatch(text); m != nil {
		comp = cleanTableCell(m[1])
	}

	// Truncate long fields
	if len(tldr) > 120 {
		tldr = tldr[:117] + "..."
	}

	return
}

// UpdateApplicationStatus updates the status of an account row in the CRM
// tracker (prospects.md, with the legacy applications.md fallbacks). The
// write-back only ever stores a canonical sales state, so the new status is run
// through normalizeStatusForWrite before being written.
func UpdateApplicationStatus(careerOpsPath string, app model.CareerApplication, newStatus string) error {
	filePath := filepath.Join(careerOpsPath, "prospects.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		filePath = filepath.Join(careerOpsPath, "data", "applications.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			filePath = filepath.Join(careerOpsPath, "applications.md")
			content, err = os.ReadFile(filePath)
			if err != nil {
				return err
			}
		}
	}

	// Only ever write a canonical sales state back to the tracker.
	canonical := normalizeStatusForWrite(newStatus)

	lines := strings.Split(string(content), "\n")
	found := false

	for i, line := range lines {
		if !strings.HasPrefix(strings.TrimSpace(line), "|") {
			continue
		}
		// Match by report number (synthesized from the report link).
		if app.ReportNumber != "" && strings.Contains(line, fmt.Sprintf("[%s]", app.ReportNumber)) {
			// Replace the status field
			lines[i] = replaceStatusInLine(line, app.Status, canonical)
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("account not found: report %s", app.ReportNumber)
	}

	return os.WriteFile(filePath, []byte(strings.Join(lines, "\n")), 0644)
}

// normalizeStatusForWrite maps an incoming status to the canonical sales label
// (capitalized, as it should appear in the tracker). Unknown values fall back to
// their normalized id title-cased so we never write a non-sales state.
func normalizeStatusForWrite(raw string) string {
	switch NormalizeStatus(raw) {
	case "new":
		return "New"
	case "qualified":
		return "Qualified"
	case "contacted":
		return "Contacted"
	case "replied":
		return "Replied"
	case "meeting":
		return "Meeting"
	case "opportunity":
		return "Opportunity"
	case "won":
		return "Won"
	case "lost":
		return "Lost"
	case "disqualified":
		return "Disqualified"
	default:
		return "New"
	}
}

// replaceStatusInLine replaces the old status with new status in a table line.
func replaceStatusInLine(line, oldStatus, newStatus string) string {
	// Case-insensitive replacement of the status field
	return strings.Replace(line, oldStatus, newStatus, 1)
}

// cleanTableCell removes trailing pipes and whitespace from a table cell value.
func cleanTableCell(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "|")
	return strings.TrimSpace(s)
}

// StatusPriority returns the sort priority for a sales state (lower = higher
// priority). Active opportunities float to the top; the terminal lost/
// disqualified states sink to the bottom.
func StatusPriority(status string) int {
	switch NormalizeStatus(status) {
	case "opportunity":
		return 0
	case "meeting":
		return 1
	case "replied":
		return 2
	case "won":
		return 3
	case "contacted":
		return 4
	case "qualified":
		return 5
	case "new":
		return 6
	case "lost":
		return 7
	case "disqualified":
		return 8
	default:
		return 9
	}
}

// ComputeProgressMetrics computes progress-oriented analytics from applications.
func ComputeProgressMetrics(apps []model.CareerApplication) model.ProgressMetrics {
	pm := model.ProgressMetrics{}

	// Count by normalized status
	statusCounts := make(map[string]int)
	var totalScore float64
	var scored int

	for _, app := range apps {
		norm := NormalizeStatus(app.Status)
		statusCounts[norm]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > pm.TopScore {
				pm.TopScore = app.Score
			}
		}

		// "Won" is the success terminal — reuse the legacy TotalOffers counter.
		if norm == "won" {
			pm.TotalOffers++
		}
		// Lost / disqualified are the terminal, non-actionable sales states.
		if norm != "lost" && norm != "disqualified" {
			pm.ActiveApps++
		}
	}

	if scored > 0 {
		pm.AvgScore = totalScore / float64(scored)
	}

	// Funnel: each stage counts all accounts that reached at least that stage.
	// An account at "meeting" has passed qualified -> contacted -> replied ->
	// meeting. "Won" implies the account passed every prior stage.
	total := len(apps)
	contacted := statusCounts["contacted"] + statusCounts["replied"] + statusCounts["meeting"] + statusCounts["opportunity"] + statusCounts["won"]
	replied := statusCounts["replied"] + statusCounts["meeting"] + statusCounts["opportunity"] + statusCounts["won"]
	meeting := statusCounts["meeting"] + statusCounts["opportunity"] + statusCounts["won"]
	opportunity := statusCounts["opportunity"] + statusCounts["won"]

	pm.FunnelStages = []model.FunnelStage{
		{Label: "Qualified", Count: total, Pct: 100.0},
		{Label: "Contacted", Count: contacted, Pct: safePct(contacted, total)},
		{Label: "Replied", Count: replied, Pct: safePct(replied, contacted)},
		{Label: "Meeting", Count: meeting, Pct: safePct(meeting, contacted)},
		{Label: "Opportunity", Count: opportunity, Pct: safePct(opportunity, contacted)},
	}

	// Rates (relative to contacted accounts)
	if contacted > 0 {
		pm.ResponseRate = float64(replied) / float64(contacted) * 100
		pm.InterviewRate = float64(meeting) / float64(contacted) * 100
		pm.OfferRate = float64(opportunity) / float64(contacted) * 100
	}

	// Score distribution
	buckets := [5]int{} // 0: 4.5-5.0, 1: 4.0-4.4, 2: 3.5-3.9, 3: 3.0-3.4, 4: <3.0
	for _, app := range apps {
		if app.Score <= 0 {
			continue
		}
		switch {
		case app.Score >= 4.5:
			buckets[0]++
		case app.Score >= 4.0:
			buckets[1]++
		case app.Score >= 3.5:
			buckets[2]++
		case app.Score >= 3.0:
			buckets[3]++
		default:
			buckets[4]++
		}
	}
	pm.ScoreBuckets = []model.ScoreBucket{
		{Label: "4.5-5.0", Count: buckets[0]},
		{Label: "4.0-4.4", Count: buckets[1]},
		{Label: "3.5-3.9", Count: buckets[2]},
		{Label: "3.0-3.4", Count: buckets[3]},
		{Label: "  <3.0", Count: buckets[4]},
	}

	// Weekly activity: group by ISO week from Date field, show last 8 weeks.
	weekCounts := make(map[string]int)
	for _, app := range apps {
		if app.Date == "" {
			continue
		}
		t, err := time.Parse("2006-01-02", app.Date)
		if err != nil {
			continue
		}
		year, week := t.ISOWeek()
		key := fmt.Sprintf("%d-W%02d", year, week)
		weekCounts[key]++
	}

	// Sort weeks and take last 8
	var weeks []string
	for w := range weekCounts {
		weeks = append(weeks, w)
	}
	sort.Strings(weeks)
	if len(weeks) > 8 {
		weeks = weeks[len(weeks)-8:]
	}

	for _, w := range weeks {
		pm.WeeklyActivity = append(pm.WeeklyActivity, model.WeekActivity{
			Week:  w,
			Count: weekCounts[w],
		})
	}

	return pm
}

// safePct returns the percentage of part/whole, or 0 if whole is 0.
func safePct(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole) * 100
}
