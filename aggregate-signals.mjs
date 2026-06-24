#!/usr/bin/env node

/**
 * aggregate-signals.mjs — roll up discovered offers to the COMPANY (account)
 * with a buying-signal strength score (Unit 3.3).
 *
 * Pure functions (trivially testable, like role-matcher / buildSalaryFilter):
 *   - aggregateByCompany(offers, opts) → per-company signal records, sorted by
 *     signalStrength desc.
 *   - renderSignalsForPipeline(signals) → company-grouped markdown for pipeline.md,
 *     keeping per-offer `- [ ] {url}` lines so scan.mjs's URL dedup still works.
 *
 * signalStrength = count + seniorityBonus + recencyBonus + repetitionBonus.
 * Monotonic in each factor; deterministic ordering. Coefficients are intentionally
 * simple and overridable — they're tuned against real scan data (deferred per plan).
 */

import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';

// Seniority tiers (higher ⇒ stronger buying signal: a Head/VP hire signals more
// intent + budget than a single IC opening).
export function seniorityTier(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(chief|cto|ceo|cio|cfo|founder|president|vp|vice\s*president|head|director)\b/.test(t)) return 3;
  if (/\b(staff|principal|lead)\b/.test(t)) return 2;
  if (/\b(senior|sr)\b/.test(t)) return 1.5;
  return 1;
}

export function roleKey(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// Same account-identity normalization merge-tracker/dedup-tracker use, so a
// company groups identically across discovery (aggregate) and the CRM (merge/
// dedup). The original `s.company` string is kept for display; only the key is
// normalized (lowercase, drop parens, collapse spaces, strip non-alnum-except
// -space, trim).
export function companyKey(company) {
  return String(company || '').toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// Recency bonus from the newest posting date. Missing/invalid → 0 (no NaN).
export function recencyBonus(newestPostedAt, now) {
  if (newestPostedAt == null || !Number.isFinite(newestPostedAt)) return 0;
  const days = (now - newestPostedAt) / 86_400_000;
  if (days <= 30) return 1;
  if (days <= 90) return 0.5;
  return 0.2;
}

export const DEFAULT_WEIGHTS = { count: 1, seniority: 1, recency: 1, repetition: 0.5 };

/**
 * @param {Array<{title?:string,url?:string,company?:string,location?:string,postedAt?:number}>} offers
 * @param {{ priorRoleKeys?: Set<string>, now?: number, weights?: typeof DEFAULT_WEIGHTS }} [opts]
 * @returns per-company signal records sorted by signalStrength desc (company asc tiebreak).
 */
export function aggregateByCompany(offers, opts = {}) {
  const { priorRoleKeys = new Set(), weights = DEFAULT_WEIGHTS } = opts;
  const now = opts.now != null ? opts.now : Date.now();

  const byCompany = new Map();
  for (const o of Array.isArray(offers) ? offers : []) {
    const ck = companyKey(o && o.company);
    if (!ck) continue;
    if (!byCompany.has(ck)) byCompany.set(ck, { company: o.company, ck, list: [] });
    byCompany.get(ck).list.push(o);
  }

  const result = [];
  for (const { company, ck, list } of byCompany.values()) {
    const roles = [...new Set(list.map(o => o.title).filter(Boolean))];
    const count = list.length;

    // Sum of (tier - 1) so an all-IC account contributes 0 seniority bonus.
    const seniorityBonus = list.reduce((s, o) => s + (seniorityTier(o.title) - 1), 0);

    const postedDates = list.map(o => o.postedAt).filter(v => Number.isFinite(v));
    const newestPostedAt = postedDates.length ? Math.max(...postedDates) : null;

    // Roles this account also showed in a PRIOR scan = sustained hiring.
    const repeatedness = roles.filter(r => priorRoleKeys.has(`${ck}::${roleKey(r)}`)).length;

    const seniorityMix = { exec: 0, seniorIc: 0, senior: 0, ic: 0 };
    for (const o of list) {
      const tier = seniorityTier(o.title);
      if (tier >= 3) seniorityMix.exec++;
      else if (tier >= 2) seniorityMix.seniorIc++;
      else if (tier >= 1.5) seniorityMix.senior++;
      else seniorityMix.ic++;
    }

    const raw =
      weights.count * count +
      weights.seniority * seniorityBonus +
      weights.recency * recencyBonus(newestPostedAt, now) +
      weights.repetition * repeatedness;
    const signalStrength = Math.round(raw * 100) / 100;

    result.push({ company, roles, count, seniorityMix, newestPostedAt, repeatedness, signalStrength });
  }

  result.sort((a, b) => b.signalStrength - a.signalStrength || a.company.localeCompare(b.company));
  return result;
}

/** Build a Set of `companyKey::roleKey` seen in a scan-history.tsv (prior scans). */
export function loadPriorRoleKeys(scanHistoryPath) {
  const keys = new Set();
  if (!scanHistoryPath || !existsSync(scanHistoryPath)) return keys;
  const lines = readFileSync(scanHistoryPath, 'utf-8').split('\n').slice(1); // skip header
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t'); // url, first_seen, portal, title, company, status, location
    const title = cols[3];
    const company = cols[4];
    if (title && company) keys.add(`${companyKey(company)}::${roleKey(title)}`);
  }
  return keys;
}

function fmtDate(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Render company-grouped signals as pipeline.md markdown. Per-offer `- [ ] {url}`
 * lines are preserved (scan.mjs's loadSeenUrls dedups off them), with a company
 * header carrying the signal strength so the inbox is account-centric.
 * @param {ReturnType<typeof aggregateByCompany>} signals
 * @param {Map<string, Array>} offersByCompanyKey - companyKey → its offers (for URLs)
 */
export function renderSignalsForPipeline(signals, offersByCompanyKey) {
  const blocks = [];
  for (const s of signals) {
    const ck = companyKey(s.company);
    const offers = (offersByCompanyKey && offersByCompanyKey.get(ck)) || [];
    const header = `### ${s.company} — signal ${s.signalStrength} ` +
      `(${s.count} role${s.count === 1 ? '' : 's'}, newest ${fmtDate(s.newestPostedAt)}` +
      `${s.repeatedness ? `, ${s.repeatedness} repeated` : ''})`;
    const lines = offers.map(o => `- [ ] ${o.url} | ${o.title || ''}`);
    blocks.push([header, ...lines].join('\n'));
  }
  return blocks.join('\n\n');
}

// ── self-test ───────────────────────────────────────────────────────────────
function selfTest() {
  const now = Date.UTC(2026, 0, 31);
  const day = 86_400_000;
  const offers = [
    { title: 'Head of ML', company: 'Acme', url: 'u1', postedAt: now - 5 * day },
    { title: 'LLMOps Engineer', company: 'Acme', url: 'u2', postedAt: now - 10 * day },
    { title: 'ML Platform Engineer', company: 'Acme', url: 'u3', postedAt: now - 200 * day },
    { title: 'Data Engineer', company: 'Globex', url: 'u4', postedAt: now - 2 * day },
  ];
  const agg = aggregateByCompany(offers, { now });
  const acme = agg.find(a => a.company === 'Acme');
  const globex = agg.find(a => a.company === 'Globex');
  if (acme.count !== 3) throw new Error('Acme count should be 3');
  if (acme.newestPostedAt !== now - 5 * day) throw new Error('Acme newest date wrong');
  if (!(acme.signalStrength > globex.signalStrength)) throw new Error('Acme (3 roles incl. exec) should outrank Globex');
  if (agg[0].company !== 'Acme') throw new Error('ordering should be signalStrength desc');
  console.log('aggregate-signals self-test OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--self-test')) selfTest();
  else {
    console.log('Usage: node aggregate-signals.mjs --self-test');
    console.log('(aggregation is invoked in-process by scan.mjs; this CLI is for self-test)');
  }
}
