#!/usr/bin/env node

/**
 * unipile-jobs-tests.mjs — tests for the Unipile client + jobs provider (Unit 3.1).
 *
 * Covers: the pure canonical mappers against the captured fixtures; DSN pinning;
 * a GUARDED transport test (real request builder via an injected fetch — not
 * mock-only) proving X-API-KEY attachment + redirect:'error' + host pin + field
 * mapping; secret/PII redaction; pagination; and graceful degradation of the
 * provider (missing creds / 403 no-entitlement → [] so the scan continues).
 * Registered in test-all.mjs scripts[].
 */

import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  mapJob, mapPerson, validateDsn, searchJobs, searchPeople, UnipileError,
  resolveLocationId, resolveCompanyId, __resetParameterCache,
  __setFetch, __resetFetch, __setSleep, __resetSleep,
} from './lib/unipile-client.mjs';
import unipileJobs from './providers/unipile-jobs.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(ROOT, 'test/fixtures/payloads/unipile', f), 'utf-8'));

let passed = 0; let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }
function ok(c, m) { (c ? pass : fail)(m); }

// fake fetch returning a fixed JSON envelope; records the last call.
function fakeFetch(envelope, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(envelope),
      json: async () => envelope,
    };
  };
  fn.calls = calls;
  return fn;
}

const SAVED_ENV = { d: process.env.UNIPILE_DSN, k: process.env.UNIPILE_API_KEY, a: process.env.UNIPILE_ACCOUNT_ID };
function setCreds({ dsn = 'https://api8.unipile.com:13443', key = 'SECRET-KEY-abc123', account = 'acct_xyz' } = {}) {
  process.env.UNIPILE_DSN = dsn; process.env.UNIPILE_API_KEY = key; process.env.UNIPILE_ACCOUNT_ID = account;
}
function clearCreds() { delete process.env.UNIPILE_DSN; delete process.env.UNIPILE_API_KEY; delete process.env.UNIPILE_ACCOUNT_ID; }

// ── Pure mappers vs the captured fixtures ──────────────────────────────────
{
  const jobs = fx('jobs.json').items.map(mapJob);
  ok(jobs[0].title.startsWith('AI & Automation Consultant') && jobs[0].url.startsWith('https://www.linkedin.com/jobs/')
    && jobs[0].company === 'SEIDOR' && /Madrid/.test(jobs[0].location) && Number.isFinite(jobs[0].postedAt),
    'mapJob → canonical {title,url,company,location,postedAt} from the jobs fixture');

  const classic = fx('people-classic.json').items.map(mapPerson);
  ok(classic[0].name === 'Piyush Narwani' && /VP of Engineering/.test(classic[0].title)
    && classic[0].linkedinUrl.startsWith('https://www.linkedin.com/in/') && classic[0].profileId.startsWith('ACoAA'),
    'mapPerson (Classic) → canonical {name,title,linkedinUrl,profileId}');

  const sn = fx('people-salesnav.json').items.map(mapPerson);
  ok(sn[0].title === 'VP of Engineering' && sn[0].linkedinUrl === 'https://www.linkedin.com/in/luciano-bana-b876a021'
    && !/\/sales\/lead\//.test(sn[0].linkedinUrl),
    'mapPerson (Sales Nav) prefers public_profile_url, never the /sales/lead/ URL');
}

// ── DSN pinning ────────────────────────────────────────────────────────────
{
  ok(validateDsn('https://api8.unipile.com:13443') === 'https://api8.unipile.com:13443', 'validateDsn accepts https *.unipile.com:port');
  ok(validateDsn('api8.unipile.com:13443').startsWith('https://'), 'validateDsn upgrades a bare host to https');
  for (const bad of ['http://api8.unipile.com:13443', 'https://evil.com', 'https://api8.unipile.com.evil.com', 'not a url']) {
    let threw = false; try { validateDsn(bad); } catch { threw = true; }
    ok(threw, `validateDsn rejects ${JSON.stringify(bad)}`);
  }
}

// ── GUARDED transport: real request builder via injected fetch ──────────────
{
  setCreds();
  const ff = fakeFetch(fx('jobs.json'));
  __setFetch(ff);
  const { offers } = await searchJobs({ keywords: 'LLMOps', limit: 25 }); // no location → single jobs POST (location path covered below)
  __resetFetch();
  const call = ff.calls[0];
  const u = new URL(call.url);
  ok(u.host === 'api8.unipile.com:13443' && u.pathname === '/api/v1/linkedin/search',
    'searchJobs POSTs to the pinned DSN host + /api/v1/linkedin/search');
  ok(u.searchParams.get('account_id') === 'acct_xyz', 'account_id is sent as a query param');
  ok(call.opts.headers['X-API-KEY'] === 'SECRET-KEY-abc123', 'X-API-KEY header is attached');
  ok(call.opts.redirect === 'error', "transport uses redirect:'error' (SSRF guard)");
  const body = JSON.parse(call.opts.body);
  ok(body.api === 'classic' && body.category === 'jobs' && /LLMOps/.test(body.keywords), 'POST body builds the classic jobs query');
  ok(offers.length === 2 && offers[0].company === 'SEIDOR', 'searchJobs maps the fixture envelope to canonical offers');
}

// ── Location resolution: name → geo id, sent as a [id] ARRAY in the jobs body ─
{
  setCreds();
  __resetParameterCache();
  const params = fx('location-params.json');
  let lastJobsBody = null; let paramCalls = 0;
  __setFetch(async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search/parameters')) {
      paramCalls += 1;
      ok(u.searchParams.get('type') === 'LOCATION', 'parameters lookup sends type=LOCATION');
      return { ok: true, status: 200, text: async () => JSON.stringify(params), json: async () => params };
    }
    lastJobsBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '', json: async () => fx('jobs.json') };
  });
  // a numeric input is returned unchanged WITHOUT a network call
  ok((await resolveLocationId('12345')) === '12345', 'resolveLocationId returns a numeric input unchanged (no fetch)');
  const { offers } = await searchJobs({ keywords: 'SDR', location: 'España', limit: 5, maxPages: 1 });
  __resetFetch();
  ok(paramCalls === 1, 'searchJobs resolves the named location once via search/parameters');
  ok(lastJobsBody.region === '105646813' && !('location' in lastJobsBody),
    'searchJobs sends the geo as `region` (single id string), not a `location` array');
  ok(offers.length === 2, 'searchJobs still maps offers after resolving the location');
}

// ── Unresolvable location degrades to account-default (omit, never 400) ──────
{
  setCreds();
  __resetParameterCache();
  let lastJobsBody = null;
  __setFetch(async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search/parameters')) {
      // no match → empty items
      return { ok: true, status: 200, text: async () => '{"items":[]}', json: async () => ({ items: [] }) };
    }
    lastJobsBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '', json: async () => fx('jobs.json') };
  });
  const { offers } = await searchJobs({ keywords: 'SDR', location: 'Nowhereland', limit: 5, maxPages: 1 });
  __resetFetch();
  ok(!('region' in lastJobsBody) && !('location' in lastJobsBody),
    'an unresolvable location is omitted from the jobs body (no 400)');
  ok(offers.length === 2, 'searchJobs still returns offers when the location is omitted');
}

// ── Pagination: follows cursor across pages ────────────────────────────────
{
  setCreds();
  let n = 0;
  __setFetch(async () => {
    n += 1;
    const envelope = n === 1
      ? { items: fx('jobs.json').items, cursor: 'PAGE2' }
      : { items: fx('jobs.json').items, cursor: null };
    return { ok: true, status: 200, text: async () => '', json: async () => envelope };
  });
  const { offers } = await searchJobs({ keywords: 'x', maxPages: 3 });
  __resetFetch();
  ok(n === 2 && offers.length === 4, 'searchJobs follows the cursor until null (2 pages → 4 offers)');
}

// ── Missing creds → redacted UnipileError, NO key leak ──────────────────────
{
  // Hermetic: loadConfig() runs dotenv.config({override:false}), so a REAL .env on
  // disk would repopulate the creds we just cleared (and even hit the network).
  // Run from a fresh empty cwd where dotenv finds no .env, so the missing-creds
  // path fires deterministically regardless of the developer's local .env.
  clearCreds();
  const prevCwd = process.cwd();
  const emptyDir = mkdtempSync(join(tmpdir(), 'unipile-nocreds-'));
  let err;
  try {
    process.chdir(emptyDir);
    await searchJobs({ keywords: 'x' });
  } catch (e) { err = e; }
  finally { process.chdir(prevCwd); rmSync(emptyDir, { recursive: true, force: true }); }
  ok(err instanceof UnipileError && err.code === 'missing_credentials', 'missing creds → UnipileError(missing_credentials)');
  ok(err && !/SECRET/.test(err.message), 'missing-creds error contains no secret');
}

// ── Redaction: a transport error never echoes the API key ───────────────────
{
  setCreds({ key: 'SUPERSECRET-zzz' });
  __setFetch(async () => { throw new Error('boom from host with key SUPERSECRET-zzz in it'); });
  let err;
  try { await searchJobs({ keywords: 'x' }); } catch (e) { err = e; }
  __resetFetch();
  ok(err && !/SUPERSECRET-zzz/.test(err.message), 'a thrown transport error redacts the API key');
}

// ── 403 no-entitlement → mapped code; provider degrades to [] ───────────────
{
  setCreds();
  __setFetch(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ type: 'errors/feature_not_subscribed' }), json: async () => ({}) }));
  let err;
  try { await searchPeople({ company: 'Acme', api: 'sales_navigator' }); } catch (e) { err = e; }
  ok(err && err.code === 'no_entitlement', '403 feature_not_subscribed → code no_entitlement');
  // provider must SWALLOW it and return [] (scan continues)
  const offers = await unipileJobs.fetch({ name: 'X', query: 'LLMOps' }, {});
  __resetFetch();
  ok(Array.isArray(offers) && offers.length === 0, 'unipile-jobs provider degrades gracefully (returns [] on error)');
}

// ── Provider drops non-LinkedIn / malformed result URLs ─────────────────────
{
  setCreds();
  __setFetch(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({
    items: [
      { title: 'Good', url: 'https://www.linkedin.com/jobs/view/1', company: { name: 'A' } },
      { title: 'Evil', url: 'http://evil.com/x', company: { name: 'B' } },
      { title: 'Bad', url: 'not-a-url', company: { name: 'C' } },
    ], cursor: null }) }));
  const offers = await unipileJobs.fetch({ name: 'X', query: 'x' }, {});
  __resetFetch();
  ok(offers.length === 1 && offers[0].title === 'Good', 'provider keeps only https linkedin.com result URLs');
}

// ── Empty results → [] (no throw) ──────────────────────────────────────────
{
  setCreds();
  __setFetch(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ items: [], cursor: null }) }));
  const { offers } = await searchJobs({ keywords: 'x' });
  __resetFetch();
  ok(offers.length === 0, 'empty Unipile result → [] (no throw)');
}

// ── GUARDED searchPeople (classic): structured company filter, real builder ────
{
  setCreds();
  __resetParameterCache();
  const companyParams = { items: [{ title: 'Acme', id: '999001' }] };
  let peopleBody = null; let paramType = null;
  __setFetch(async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search/parameters')) {
      paramType = u.searchParams.get('type');
      return { ok: true, status: 200, text: async () => JSON.stringify(companyParams), json: async () => companyParams };
    }
    peopleBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '', json: async () => fx('people-classic.json') };
  });
  const { contacts } = await searchPeople({ company: 'Acme', keywords: 'VP Engineering', api: 'classic' });
  __resetFetch();
  ok(paramType === 'COMPANY', 'searchPeople resolves the company via search/parameters?type=COMPANY');
  ok(peopleBody.category === 'people' && peopleBody.api === 'classic', 'searchPeople POSTs a people query');
  ok(Array.isArray(peopleBody.company) && peopleBody.company[0] === '999001',
    'classic people search scopes by company:["<id>"] (structured filter)');
  ok(peopleBody.keywords === 'VP Engineering',
    'the company name is NOT jammed into keywords (structured filter, not text match)');
  ok(contacts.length === 2 && contacts[0].name === 'Piyush Narwani', 'searchPeople maps the people envelope to canonical contacts');
}

// ── searchPeople (Sales Navigator) uses the company:{include:[id]} shape ───────
{
  setCreds();
  __resetParameterCache();
  const companyParams = { items: [{ title: 'Acme', id: '999001' }] };
  let peopleBody = null;
  __setFetch(async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search/parameters')) return { ok: true, status: 200, text: async () => JSON.stringify(companyParams), json: async () => companyParams };
    peopleBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '', json: async () => fx('people-salesnav.json') };
  });
  await searchPeople({ company: 'Acme', keywords: 'Head of Sales', api: 'sales_navigator' });
  __resetFetch();
  ok(peopleBody.company && Array.isArray(peopleBody.company.include) && peopleBody.company.include[0] === '999001',
    'sales_navigator people search scopes by company:{include:["<id>"]}');
}

// ── searchPeople degrades to a keyword query when the company can't be resolved ─
{
  setCreds();
  __resetParameterCache();
  let peopleBody = null;
  __setFetch(async (url, opts) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search/parameters')) return { ok: true, status: 200, text: async () => '{"items":[]}', json: async () => ({ items: [] }) };
    peopleBody = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '', json: async () => fx('people-classic.json') };
  });
  await searchPeople({ company: 'NoSuchCo', keywords: 'VP', api: 'classic' });
  __resetFetch();
  ok(!('company' in peopleBody) && /NoSuchCo/.test(peopleBody.keywords) && /VP/.test(peopleBody.keywords),
    'an unresolvable company falls back to the keyword query (no structured filter)');
}

// ── 429 backoff: retries the transient status, succeeds on a later page ─────
{
  setCreds();
  __setSleep(async () => {}); // no real delay in tests
  let n = 0;
  __setFetch(async () => {
    n += 1;
    if (n < 3) return { ok: false, status: 429, text: async () => JSON.stringify({ type: 'errors/rate_limited' }), json: async () => ({}) };
    return { ok: true, status: 200, text: async () => '', json: async () => fx('jobs.json') };
  });
  const { offers } = await searchJobs({ keywords: 'x' });
  __resetFetch(); __resetSleep();
  ok(n === 3 && offers.length === 2, 'searchJobs retries 429 with backoff then succeeds (2 retries)');
}

// ── 429 persistent: maps to rate_limited; provider degrades to [] ──────────
{
  setCreds();
  __setSleep(async () => {});
  __setFetch(async () => ({ ok: false, status: 429, text: async () => '', json: async () => ({}) }));
  let err;
  try { await searchJobs({ keywords: 'x' }); } catch (e) { err = e; }
  ok(err && err.code === 'rate_limited' && err.status === 429, 'persistent 429 → UnipileError(rate_limited)');
  const offers = await unipileJobs.fetch({ name: 'X', query: 'x' }, {});
  __resetFetch(); __resetSleep();
  ok(Array.isArray(offers) && offers.length === 0, 'provider degrades to [] on persistent 429');
}

// ── Mapper edge cases (null / fallback / string-company) ────────────────────
{
  ok(mapJob(null) === null && mapJob(undefined) === null, 'mapJob(null|undefined) → null');
  ok(mapPerson(null) === null, 'mapPerson(null) → null');
  ok(mapJob({ title: 'T', url: 'https://x/1', company: 'StringCo' }).company === 'StringCo', 'mapJob tolerates a string company');
  ok(mapPerson({ first_name: 'Ada', last_name: 'Lovelace', headline: 'Eng', id: 'ACoAA1', public_identifier: 'ada' }).name === 'Ada Lovelace',
    'mapPerson falls back to first_name + last_name when name is absent');
}

// restore env
__resetFetch();
__resetSleep();
if (SAVED_ENV.d != null) process.env.UNIPILE_DSN = SAVED_ENV.d; else delete process.env.UNIPILE_DSN;
if (SAVED_ENV.k != null) process.env.UNIPILE_API_KEY = SAVED_ENV.k; else delete process.env.UNIPILE_API_KEY;
if (SAVED_ENV.a != null) process.env.UNIPILE_ACCOUNT_ID = SAVED_ENV.a; else delete process.env.UNIPILE_ACCOUNT_ID;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
