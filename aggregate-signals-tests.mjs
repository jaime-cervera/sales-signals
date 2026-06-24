#!/usr/bin/env node

/**
 * aggregate-signals-tests.mjs — tests for account-level signal aggregation
 * (Unit 3.3). Registered in test-all.mjs scripts[].
 */

import {
  aggregateByCompany, recencyBonus, seniorityTier, renderSignalsForPipeline, companyKey,
} from './aggregate-signals.mjs';

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(cond, m) { (cond ? pass : fail)(m); }

const NOW = Date.UTC(2026, 0, 31);
const day = 86_400_000;

// ── Happy: 3 offers at one company → one signal, count 3, correct newest ───
{
  const offers = [
    { title: 'LLMOps Engineer', company: 'Acme', url: 'a1', postedAt: NOW - 3 * day },
    { title: 'ML Platform Engineer', company: 'Acme', url: 'a2', postedAt: NOW - 10 * day },
    { title: 'Senior MLOps Engineer', company: 'Acme', url: 'a3', postedAt: NOW - 1 * day },
  ];
  const agg = aggregateByCompany(offers, { now: NOW });
  ok(agg.length === 1, 'three offers at one company → one aggregated signal');
  ok(agg[0].count === 3, 'count is 3');
  ok(agg[0].newestPostedAt === NOW - 1 * day, 'newestPostedAt is the most recent offer');
  ok(agg[0].roles.length === 3, 'three distinct roles captured');
}

// ── Edge: missing postedAt → recency degrades gracefully, no NaN ───────────
{
  const offers = [
    { title: 'Data Engineer', company: 'Globex', url: 'g1' }, // no postedAt
    { title: 'Analytics Engineer', company: 'Globex', url: 'g2', postedAt: NOW - 5 * day },
  ];
  const agg = aggregateByCompany(offers, { now: NOW });
  ok(Number.isFinite(agg[0].signalStrength), 'signalStrength is a finite number with a missing postedAt');
  ok(agg[0].newestPostedAt === NOW - 5 * day, 'newest uses the only valid date');
  ok(recencyBonus(undefined, NOW) === 0 && recencyBonus(null, NOW) === 0 && !Number.isNaN(recencyBonus(NaN, NOW)),
    'recencyBonus(missing) is 0, never NaN');
}

// ── Edge: repetition across scans increments (not counted as new) ──────────
{
  const offers = [
    { title: 'LLMOps Engineer', company: 'Acme', url: 'a1', postedAt: NOW - 3 * day },
    { title: 'New Role', company: 'Acme', url: 'a2', postedAt: NOW - 3 * day },
  ];
  const prior = new Set([`${companyKey('Acme')}::llmops engineer`]);
  const withRep = aggregateByCompany(offers, { now: NOW, priorRoleKeys: prior });
  const noRep = aggregateByCompany(offers, { now: NOW });
  ok(withRep[0].repeatedness === 1, 'a role seen in a prior scan counts as 1 repeated');
  ok(withRep[0].signalStrength > noRep[0].signalStrength, 'repetition raises signalStrength (sustained hiring)');
}

// ── Edge: seniority weighting reflected in score ordering ──────────────────
{
  const execCo = [{ title: 'Head of ML', company: 'ExecCo', url: 'e1', postedAt: NOW - 2 * day }];
  const icCo = [{ title: 'ML Engineer', company: 'IcCo', url: 'i1', postedAt: NOW - 2 * day }];
  const agg = aggregateByCompany([...execCo, ...icCo], { now: NOW });
  ok(seniorityTier('Head of ML') > seniorityTier('Senior ML Engineer'), 'Head outranks Senior');
  ok(seniorityTier('Senior ML Engineer') > seniorityTier('ML Engineer'), 'Senior outranks IC');
  ok(agg[0].company === 'ExecCo', 'a same-count exec hire outscores an IC hire');
}

// ── Happy: deterministic ordering by signalStrength desc ───────────────────
{
  const offers = [
    { title: 'ML Engineer', company: 'Low', url: 'l1', postedAt: NOW - 200 * day },
    { title: 'Head of ML', company: 'High', url: 'h1', postedAt: NOW - 1 * day },
    { title: 'Staff ML Engineer', company: 'Mid', url: 'm1', postedAt: NOW - 1 * day },
  ];
  const a = aggregateByCompany(offers, { now: NOW });
  const order = a.map(s => s.company);
  const strengths = a.map(s => s.signalStrength);
  ok(JSON.stringify(order) === JSON.stringify(['High', 'Mid', 'Low']), `deterministic order High>Mid>Low (got ${order})`);
  ok(strengths[0] >= strengths[1] && strengths[1] >= strengths[2], 'signalStrength is non-increasing');
  // Re-run → identical (deterministic).
  ok(JSON.stringify(aggregateByCompany(offers, { now: NOW })) === JSON.stringify(a), 'aggregation is deterministic on re-run');
}

// ── renderSignalsForPipeline keeps per-offer URL lines (dedup-safe) ────────
{
  const offers = [
    { title: 'LLMOps Engineer', company: 'Acme', url: 'https://x/1', postedAt: NOW - 3 * day },
    { title: 'ML Platform', company: 'Acme', url: 'https://x/2', postedAt: NOW - 3 * day },
  ];
  const agg = aggregateByCompany(offers, { now: NOW });
  const byCo = new Map([[companyKey('Acme'), offers]]);
  const md = renderSignalsForPipeline(agg, byCo);
  ok(/### Acme — signal/.test(md), 'render emits a company header with signal strength');
  ok(/- \[ \] https:\/\/x\/1/.test(md) && /- \[ \] https:\/\/x\/2/.test(md),
    'render preserves per-offer "- [ ] {url}" lines (scan dedup stays intact)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
