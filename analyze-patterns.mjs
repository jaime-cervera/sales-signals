#!/usr/bin/env node
/**
 * analyze-patterns.mjs — Buying-Signal Conversion Analyzer for Sales-Signals
 *
 * Parses the CRM tracker (prospects.md) + all linked account dossiers, groups
 * accounts by buying SIGNAL and by ICP-fit, classifies outcomes by sales Status
 * (Won/Opportunity = conversion; Lost/Disqualified = loss), and outputs
 * structured JSON surfacing which signals convert and which leak.
 *
 * The tracker is the 8-column CRM table (see templates/crm-schema.md):
 *   | Company | Signal | SignalDate | ICPScore | Status | Contact | Report | Notes |
 * Columns are mapped by HEADER NAME (not fixed position).
 *
 * Run: node analyze-patterns.mjs          (JSON to stdout)
 *      node analyze-patterns.mjs --summary (human-readable table)
 *      node analyze-patterns.mjs --min-threshold 3
 *      node analyze-patterns.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_TRACKER / CAREER_OPS_REPORTS scope these to the active ICP (set by
// bin/signals.mjs). Unset → the legacy defaults, so behaviour is identical when
// not run through the ICP launcher.
const APPS_FILE = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS || join(CAREER_OPS, 'reports');

const MACHINE_SUMMARY_FIELDS = new Set([
  'company',
  'role',
  'score',
  'legitimacy_tier',
  'archetype',
  'final_decision',
  'hard_stops',
  'soft_gaps',
  'top_strengths',
  'risk_level',
  'confidence',
  'next_action',
  // Optional context fields accepted for future reports.
  'domain',
  'seniority',
  'remote',
  'team_size',
]);

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const minThresholdIdx = args.indexOf('--min-threshold');
const MIN_THRESHOLD = minThresholdIdx !== -1 && args[minThresholdIdx + 1] !== undefined
  ? (Number.isNaN(parseInt(args[minThresholdIdx + 1])) ? 5 : parseInt(args[minThresholdIdx + 1]))
  : 5;

// --- Status normalization (canonical SALES states; mirrors states.yml) ---
const ALIASES = {
  'new': 'new', 'nuevo': 'new', 'detected': 'new', 'signal': 'new',
  'qualified': 'qualified', 'cualificado': 'qualified', 'qualify': 'qualified',
  'contacted': 'contacted', 'contactado': 'contacted', 'outreach': 'contacted', 'reached_out': 'contacted',
  'replied': 'replied', 'respondido': 'replied', 'responded': 'replied',
  'meeting': 'meeting', 'reunion': 'meeting', 'meeting_booked': 'meeting', 'demo': 'meeting',
  'opportunity': 'opportunity', 'oportunidad': 'opportunity', 'deal': 'opportunity', 'opp': 'opportunity',
  'won': 'won', 'ganado': 'won', 'closed_won': 'won', 'customer': 'won',
  'lost': 'lost', 'perdido': 'lost', 'closed_lost': 'lost',
  'disqualified': 'disqualified', 'descalificado': 'disqualified', 'disqualify': 'disqualified',
  'not_a_fit': 'disqualified', 'no_fit': 'disqualified', 'skip': 'disqualified',
};

function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

/**
 * Classify a sales Status into a conversion outcome bucket:
 *   conversion    — Won / Opportunity (the signal turned into a deal)
 *   in_pipeline   — Contacted / Replied / Meeting (active, no verdict yet)
 *   loss          — Lost / Disqualified (the signal did not convert)
 *   untouched     — New / Qualified (not yet worked)
 */
function classifyOutcome(status) {
  const s = normalizeStatus(status);
  if (['won', 'opportunity'].includes(s)) return 'conversion';
  if (['contacted', 'replied', 'meeting'].includes(s)) return 'in_pipeline';
  if (['lost', 'disqualified'].includes(s)) return 'loss';
  return 'untouched'; // new / qualified
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'object') return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeScalar(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parseMachineSummary(content) {
  const fenceMatch = content.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (!fenceMatch) return null;

  const raw = fenceMatch[1].trim();
  if (!raw) return null;

  try {
    const parsed = yamlLoad(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => MACHINE_SUMMARY_FIELDS.has(key))
    );
  } catch {
    return null;
  }
}

function runSelfTest() {
  const summary = parseMachineSummary(`
## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Staff AI Engineer"
score: 4.4
legitimacy_tier: "High Confidence"
archetype: "AI Platform / LLMOps Engineer"
final_decision: "Apply"
hard_stops: []
soft_gaps:
  - "No direct healthcare domain experience"
top_strengths:
  - "Production evaluation pipelines"
risk_level: "Medium"
confidence: "High"
next_action: "Follow up on ticket #42 with tailored CV"
\`\`\`
`);

  const failures = [];
  if (!summary) failures.push('summary was not parsed');
  if (summary?.score !== 4.4) failures.push('numeric score was not parsed');
  if (!Array.isArray(summary?.hard_stops) || summary.hard_stops.length !== 0) failures.push('empty list was not parsed');
  if (summary?.soft_gaps?.[0] !== 'No direct healthcare domain experience') failures.push('list item was not parsed');
  if (summary?.next_action !== 'Follow up on ticket #42 with tailored CV') failures.push('hash-containing scalar field was not parsed');

  if (failures.length > 0) {
    console.error(`Machine Summary parser self-test failed: ${failures.join('; ')}`);
    process.exit(1);
  }

  console.log('Machine Summary parser self-test OK');
  process.exit(0);
}

// Header-name column mapping (CRM schema). Columns are located by header NAME,
// never by fixed position (see templates/crm-schema.md / normalize-statuses.mjs).
const HEADER_ALIASES = {
  'company': 'company', 'empresa': 'company',
  'signal': 'signal', 'señal': 'signal', 'senal': 'signal',
  'signaldate': 'signaldate', 'signal date': 'signaldate', 'date': 'signaldate',
  'icpscore': 'score', 'icp score': 'score', 'score': 'score',
  'status': 'status', 'estado': 'status',
  'contact': 'contact', 'contacto': 'contact',
  'report': 'report', 'informe': 'report',
  'notes': 'notes', 'notas': 'notes',
};

/**
 * Detect CRM column indices by header NAME (Company + Status minimum).
 *
 * @param {string[]} allLines - All lines of the tracker file.
 * @returns {object|null} header-name → column-index map, or null if not found.
 */
function detectColumns(allLines) {
  for (const line of allLines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim().toLowerCase());
    if (!cells.includes('company') || !cells.includes('status')) continue;
    const map = {};
    cells.forEach((c, i) => { if (HEADER_ALIASES[c] != null) map[HEADER_ALIASES[c]] = i; });
    if (map.company != null && map.status != null) return map;
  }
  return null;
}

// --- Parse the CRM prospects.md (one row per account) ---
function parseTracker() {
  if (!existsSync(APPS_FILE)) return [];
  const content = readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');
  const cols = detectColumns(lines);
  if (!cols) return [];
  const maxIdx = Math.max(...Object.values(cols));
  const cell = (parts, key) => (cols[key] != null ? (parts[cols[key]] || '') : '');

  const entries = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length <= maxIdx) continue;
    const company = cell(parts, 'company');
    if (!company || company.toLowerCase() === 'company') continue;
    entries.push({
      company,
      signal: cell(parts, 'signal'),
      date: cell(parts, 'signaldate'),
      score: cell(parts, 'score'),
      status: cell(parts, 'status'),
      contact: cell(parts, 'contact'),
      report: cell(parts, 'report'),
      notes: cell(parts, 'notes'),
    });
  }
  return entries;
}

// --- Parse a single report file ---
function parseReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  const content = readFileSync(reportPath, 'utf-8');
  const report = {
    company: null,
    role: null,
    archetype: null,
    legitimacyTier: null,
    finalDecision: null,
    seniority: null,
    remote: null,
    teamSize: null,
    comp: null,
    domain: null,
    riskLevel: null,
    confidence: null,
    nextAction: null,
    topStrengths: [],
    scores: {},
    gaps: [],
  };

  const machineSummary = parseMachineSummary(content);
  if (machineSummary) {
    report.machineSummary = machineSummary;
    report.company = normalizeScalar(machineSummary.company) || report.company;
    report.role = normalizeScalar(machineSummary.role) || report.role;
    report.archetype = normalizeScalar(machineSummary.archetype) || report.archetype;
    report.legitimacyTier = normalizeScalar(machineSummary.legitimacy_tier) || report.legitimacyTier;
    report.finalDecision = normalizeScalar(machineSummary.final_decision) || report.finalDecision;
    report.domain = normalizeScalar(machineSummary.domain) || report.domain;
    report.seniority = normalizeScalar(machineSummary.seniority) || report.seniority;
    report.remote = normalizeScalar(machineSummary.remote) || report.remote;
    report.teamSize = normalizeScalar(machineSummary.team_size) || report.teamSize;
    report.riskLevel = normalizeScalar(machineSummary.risk_level) || report.riskLevel;
    report.confidence = normalizeScalar(machineSummary.confidence) || report.confidence;
    report.nextAction = normalizeScalar(machineSummary.next_action) || report.nextAction;
    report.topStrengths = normalizeList(machineSummary.top_strengths);

    if (typeof machineSummary.score === 'number') {
      report.scores.global = machineSummary.score;
    }

    for (const hardStop of normalizeList(machineSummary.hard_stops)) {
      report.gaps.push({ description: hardStop, severity: 'hard stop', mitigation: '' });
    }
    for (const softGap of normalizeList(machineSummary.soft_gaps)) {
      report.gaps.push({ description: softGap, severity: 'soft gap', mitigation: '' });
    }
  }

  // Strip bold markers for easier matching
  const plain = content.replace(/\*\*/g, '');

  // Extract Block A table (Role Summary) — works with both EN and ES headers
  // Archetype cell may be labeled "Archetype", "Arquetipo", or "Detected archetype" (drift from EN translation).
  const blockARegex = /\|\s*(?:Detected\s+)?(?:Archetype|Arquetipo)\s*\|\s*(.*?)\s*\|/i;
  const seniorityRegex = /\|\s*(?:Seniority|Nivel|Level)\s*\|\s*(.*?)\s*\|/i;
  const remoteRegex = /\|\s*(?:Remote|Remoto|Location)\s*\|\s*(.*?)\s*\|/i;
  const teamRegex = /\|\s*(?:Team|Team size|Equipo)\s*\|\s*(.*?)\s*\|/i;
  const compRegex = /\|\s*(?:Comp|Salary|Salario|Listed salary)\s*\|\s*(.*?)\s*\|/i;
  const domainRegex = /\|\s*(?:Domain|Dominio|Industry)\s*\|\s*(.*?)\s*\|/i;

  // Fallback: report header field `Archetype: ...` or `Arquetipo: ...` (newer reports use this).
  const headerArchRegex = /^(?:Archetype|Arquetipo):\s*(.+?)$/im;

  const archMatch = plain.match(blockARegex) || plain.match(headerArchRegex);
  if (archMatch && !report.archetype) report.archetype = archMatch[1].trim();

  const senMatch = plain.match(seniorityRegex);
  if (senMatch && !report.seniority) report.seniority = senMatch[1].trim();

  const remMatch = plain.match(remoteRegex);
  if (remMatch && !report.remote) report.remote = remMatch[1].trim();

  const teamMatch = plain.match(teamRegex);
  if (teamMatch && !report.teamSize) report.teamSize = teamMatch[1].trim();

  const compMatch = plain.match(compRegex);
  if (compMatch && !report.comp) report.comp = compMatch[1].trim();

  const domainMatch = plain.match(domainRegex);
  if (domainMatch && !report.domain) report.domain = domainMatch[1].trim();

  // Extract scoring table — look for table with "Global" row (using plain, bold already stripped)
  const scoreRegex = /\|\s*(?:CV Match|Match con CV)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const northStarRegex = /\|\s*(?:North Star)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const compScoreRegex = /\|\s*(?:Comp)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const culturalRegex = /\|\s*(?:Cultural signals|Cultural)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const redFlagsRegex = /\|\s*(?:Red flags)\s*\|\s*([-+]?[\d.]+)\s*\|/i;
  const globalRegex = /\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i;

  const cvScoreMatch = plain.match(scoreRegex);
  if (cvScoreMatch && report.scores.cvMatch === undefined) report.scores.cvMatch = parseFloat(cvScoreMatch[1]);

  const nsMatch = plain.match(northStarRegex);
  if (nsMatch && report.scores.northStar === undefined) report.scores.northStar = parseFloat(nsMatch[1]);

  const csMatch = plain.match(compScoreRegex);
  if (csMatch && report.scores.comp === undefined) report.scores.comp = parseFloat(csMatch[1]);

  const culMatch = plain.match(culturalRegex);
  if (culMatch && report.scores.cultural === undefined) report.scores.cultural = parseFloat(culMatch[1]);

  const rfMatch = plain.match(redFlagsRegex);
  if (rfMatch && report.scores.redFlags === undefined) report.scores.redFlags = parseFloat(rfMatch[1]);

  const glMatch = plain.match(globalRegex);
  if (glMatch && report.scores.global === undefined) report.scores.global = parseFloat(glMatch[1]);

  // Extract gaps table
  const gapTableRegex = /\|\s*Gap\s*\|\s*Severity\s*\|.*?\n\|[-|\s]+\n([\s\S]*?)(?:\n\n|\n##|\n\*\*|$)/i;
  const gapTableMatch = content.match(gapTableRegex);
  if (gapTableMatch) {
    const gapRows = gapTableMatch[1].split('\n').filter(r => r.startsWith('|'));
    for (const row of gapRows) {
      const cols = row.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const duplicate = report.gaps.some(g => g.description.toLowerCase() === cols[0].toLowerCase());
        if (!duplicate) {
          report.gaps.push({
            description: cols[0],
            severity: cols[1].toLowerCase(),
            mitigation: cols[2] || '',
          });
        }
      }
    }
  }

  return report;
}

// --- Normalize a buying signal into a comparable group label ---
// The CRM `Signal` cell is free-form ("LLMOps Engineer ×2", "Senior Data
// Engineer + 1 more"). Strip counts / multipliers so the same role-signal groups
// together. Falls back to the report's detected archetype, then "Unknown".
function classifySignal(rawSignal, reportArchetype) {
  const fromTracker = String(rawSignal || '')
    .replace(/[×x]\s*\d+/gi, '')          // "×2", "x3"
    .replace(/\+\s*\d+\s*more/gi, '')      // "+1 more"
    .replace(/\(\s*\d+\s*\)/g, '')         // "(2)"
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (fromTracker && fromTracker !== '—' && fromTracker !== '-') return fromTracker;
  if (reportArchetype) return reportArchetype;
  return 'Unknown';
}

// --- Band an ICP-fit score into a comparable bucket ---
function classifyIcpFit(score) {
  if (!Number.isFinite(score) || score <= 0) return 'unscored';
  if (score >= 4.5) return 'strong fit (4.5+)';
  if (score >= 4.0) return 'good fit (4.0-4.4)';
  if (score >= 3.0) return 'marginal fit (3.0-3.9)';
  return 'weak fit (<3.0)';
}

// --- Main analysis ---
function analyze() {
  const entries = parseTracker();

  if (entries.length === 0) {
    return { error: 'No accounts found in tracker.' };
  }

  // Enrich entries with report data and conversion classification.
  const enriched = entries.map(e => {
    const reportMatch = e.report.match(/\]\(([^)]+)\)/);
    const reportPath = reportMatch ? join(CAREER_OPS, reportMatch[1]) : null;
    const reportData = reportPath ? parseReport(reportPath) : null;
    const outcome = classifyOutcome(e.status);
    // Strip Markdown bolding before parsing — `**4.2**` parses as NaN otherwise
    // (mirrors merge-tracker/dedup-tracker's parseScore).
    const trackerScore = parseFloat(String(e.score ?? '').replace(/\*\*/g, ''));
    const score = Number.isFinite(trackerScore)
      ? trackerScore
      : (Number.isFinite(reportData?.scores?.global) ? reportData.scores.global : 0);

    return {
      ...e,
      normalizedStatus: normalizeStatus(e.status),
      outcome,
      score,
      report: reportData,
      signalGroup: classifySignal(e.signal, reportData?.archetype),
      icpFit: classifyIcpFit(score),
    };
  });

  // Count accounts that have actually been WORKED (beyond New/Qualified). Below
  // the threshold there is no conversion signal worth analysing yet.
  const worked = enriched.filter(e => !['new', 'qualified'].includes(e.normalizedStatus));
  if (worked.length < MIN_THRESHOLD) {
    return {
      error: `Not enough data: ${worked.length}/${MIN_THRESHOLD} accounts worked beyond "Qualified". Keep working signals and come back later.`,
      current: worked.length,
      threshold: MIN_THRESHOLD,
    };
  }

  // --- Pipeline funnel (count per sales stage) ---
  const funnel = {};
  for (const e of enriched) {
    const s = e.normalizedStatus;
    funnel[s] = (funnel[s] || 0) + 1;
  }

  // --- ICP score comparison by conversion outcome ---
  const scoresByOutcome = { conversion: [], in_pipeline: [], loss: [], untouched: [] };
  for (const e of enriched) {
    if (e.score > 0) scoresByOutcome[e.outcome].push(e.score);
  }

  const scoreStats = (arr) => {
    if (arr.length === 0) return { avg: 0, min: 0, max: 0, count: 0 };
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return {
      avg: Math.round(avg * 100) / 100,
      min: Math.min(...arr),
      max: Math.max(...arr),
      count: arr.length,
    };
  };

  const scoreComparison = {
    conversion: scoreStats(scoresByOutcome.conversion),
    in_pipeline: scoreStats(scoresByOutcome.in_pipeline),
    loss: scoreStats(scoresByOutcome.loss),
    untouched: scoreStats(scoresByOutcome.untouched),
  };

  // --- Which buying signals convert ---
  // conversion rate = conversions / decided, where decided = conversion + loss.
  const signalMap = new Map();
  for (const e of enriched) {
    const key = e.signalGroup;
    if (!signalMap.has(key)) signalMap.set(key, { total: 0, conversion: 0, in_pipeline: 0, loss: 0, untouched: 0 });
    const entry = signalMap.get(key);
    entry.total++;
    entry[e.outcome]++;
  }
  const signalConversion = [...signalMap.entries()].map(([signal, data]) => {
    const decided = data.conversion + data.loss;
    return {
      signal,
      ...data,
      conversionRate: decided > 0 ? Math.round((data.conversion / decided) * 100) : 0,
    };
  }).sort((a, b) => b.total - a.total);

  // --- ICP-fit band breakdown ---
  const fitMap = new Map();
  for (const e of enriched) {
    const key = e.icpFit;
    if (!fitMap.has(key)) fitMap.set(key, { total: 0, conversion: 0, in_pipeline: 0, loss: 0, untouched: 0 });
    const entry = fitMap.get(key);
    entry.total++;
    entry[e.outcome]++;
  }
  const icpFitBreakdown = [...fitMap.entries()].map(([band, data]) => {
    const decided = data.conversion + data.loss;
    return {
      band,
      ...data,
      conversionRate: decided > 0 ? Math.round((data.conversion / decided) * 100) : 0,
    };
  }).sort((a, b) => b.total - a.total);

  // --- ICP score threshold (lowest score that ever converted) ---
  const convertingScores = scoresByOutcome.conversion.filter(s => s > 0);
  const minConvertingScore = convertingScores.length > 0 ? Math.min(...convertingScores) : 0;
  const scoreThreshold = {
    recommended: minConvertingScore > 0 ? Math.floor(minConvertingScore * 10) / 10 : 3.5,
    reasoning: convertingScores.length > 0
      ? `Lowest ICP score among converting accounts is ${minConvertingScore}. No accounts below this converted.`
      : 'Not enough converting accounts to determine a threshold.',
    convertingRange: convertingScores.length > 0
      ? `${Math.min(...convertingScores)} - ${Math.max(...convertingScores)}`
      : 'N/A',
  };

  // --- Generate recommendations ---
  const recommendations = [];

  // Best converting signal — double down.
  const bestSignal = signalConversion
    .filter(s => (s.conversion + s.loss) >= 2)
    .sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (bestSignal && bestSignal.conversionRate > 0) {
    recommendations.push({
      action: `Prioritize "${bestSignal.signal}" signals (${bestSignal.conversionRate}% win rate)`,
      reasoning: `${bestSignal.conversion} of ${bestSignal.conversion + bestSignal.loss} decided "${bestSignal.signal}" accounts converted to a deal.`,
      impact: 'high',
    });
  }

  // Worst converting signal — deprioritize.
  const worstSignal = signalConversion
    .filter(s => (s.conversion + s.loss) >= 2 && s.conversionRate === 0)[0];
  if (worstSignal) {
    recommendations.push({
      action: `Deprioritize "${worstSignal.signal}" signals (0% win rate across ${worstSignal.conversion + worstSignal.loss} decided accounts)`,
      reasoning: `None of the decided "${worstSignal.signal}" accounts converted — these signals leak.`,
      impact: 'high',
    });
  }

  // ICP score threshold recommendation.
  if (minConvertingScore > 3.0) {
    recommendations.push({
      action: `Set a minimum ICP score of ${scoreThreshold.recommended}/5 before working a signal`,
      reasoning: `No accounts below ${minConvertingScore}/5 converted. Working lower-fit signals leaks effort.`,
      impact: 'medium',
    });
  }

  // Best ICP-fit band recommendation.
  const bestFit = icpFitBreakdown
    .filter(f => f.band !== 'unscored' && (f.conversion + f.loss) >= 2)
    .sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (bestFit && bestFit.conversionRate > 0) {
    recommendations.push({
      action: `Focus on "${bestFit.band}" accounts (${bestFit.conversionRate}% win rate)`,
      reasoning: `${bestFit.conversion} of ${bestFit.conversion + bestFit.loss} decided accounts in this fit band converted.`,
      impact: 'medium',
    });
  }

  // Date range
  const dates = enriched.map(e => e.date).filter(Boolean).sort();

  return {
    metadata: {
      total: enriched.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      byOutcome: {
        conversion: enriched.filter(e => e.outcome === 'conversion').length,
        in_pipeline: enriched.filter(e => e.outcome === 'in_pipeline').length,
        loss: enriched.filter(e => e.outcome === 'loss').length,
        untouched: enriched.filter(e => e.outcome === 'untouched').length,
      },
    },
    funnel,
    scoreComparison,
    signalConversion,
    icpFitBreakdown,
    scoreThreshold,
    recommendations,
  };
}

// --- Summary mode (human-readable) ---
function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }

  const { metadata, funnel, scoreComparison, signalConversion, icpFitBreakdown, scoreThreshold, recommendations } = result;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Buying-Signal Conversion Analysis — ${metadata.analysisDate}`);
  console.log(`  ${metadata.total} accounts (${metadata.dateRange.from} to ${metadata.dateRange.to})`);
  console.log(`${'='.repeat(60)}\n`);

  // Pipeline funnel
  console.log('PIPELINE FUNNEL');
  console.log('-'.repeat(40));
  const funnelOrder = ['new', 'qualified', 'contacted', 'replied', 'meeting', 'opportunity', 'won', 'lost', 'disqualified'];
  for (const status of funnelOrder) {
    if (funnel[status]) {
      const pct = Math.round((funnel[status] / metadata.total) * 100);
      console.log(`  ${status.padEnd(15)} ${String(funnel[status]).padStart(3)} (${pct}%)`);
    }
  }

  // ICP score comparison
  console.log('\nICP SCORE BY OUTCOME');
  console.log('-'.repeat(40));
  for (const [group, stats] of Object.entries(scoreComparison)) {
    if (stats.count > 0) {
      console.log(`  ${group.padEnd(15)} avg ${stats.avg}/5  (${stats.count} accounts, range ${stats.min}-${stats.max})`);
    }
  }

  // Which signals convert
  if (signalConversion.length > 0) {
    console.log('\nSIGNAL CONVERSION (won / decided)');
    console.log('-'.repeat(40));
    for (const s of signalConversion) {
      console.log(`  ${s.signal.substring(0, 24).padEnd(26)} ${String(s.total).padStart(2)} total, ${s.conversion} won (${s.conversionRate}%)`);
    }
  }

  // ICP-fit bands
  if (icpFitBreakdown.length > 0) {
    console.log('\nICP-FIT BANDS');
    console.log('-'.repeat(40));
    for (const f of icpFitBreakdown) {
      console.log(`  ${f.band.padEnd(22)} ${String(f.total).padStart(2)} total, ${f.conversion} won (${f.conversionRate}%)`);
    }
  }

  // Score threshold
  console.log(`\nICP SCORE THRESHOLD: ${scoreThreshold.recommended}/5`);
  console.log(`  ${scoreThreshold.reasoning}`);

  // Recommendations
  if (recommendations.length > 0) {
    console.log(`\nRECOMMENDATIONS`);
    console.log('='.repeat(60));
    for (let i = 0; i < recommendations.length; i++) {
      const r = recommendations[i];
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`);
      console.log(`     ${r.reasoning}`);
    }
  }

  console.log('');
}

// --- Run ---
if (args.includes('--self-test')) {
  runSelfTest();
}

const result = analyze();

if (summaryMode) {
  printSummary(result);
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.error) process.exit(1);
