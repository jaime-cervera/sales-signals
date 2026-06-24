/**
 * lib/unipile-client.mjs — auth/transport for the Unipile LinkedIn search API.
 *
 * The single contract-isolation layer for Unipile (Unit 3.1 + Phase 5). It is the
 * ONLY place that reads the Unipile credentials, pins the per-tenant DSN, attaches
 * the API key, and maps Unipile's response fields to our canonical shapes — so a
 * real captured response can correct any RUNTIME-VALIDATE field (see
 * docs/spikes/unipile-shapes-2026-06-17.md) in exactly one file.
 *
 * Security / hygiene (the key grants the connected account's Sales Nav reach):
 *   - The MODULE TOP-LEVEL IS INERT — no env reads, no dotenv, no DSN validation
 *     at import. `loadProviders` imports providers/unipile-jobs.mjs (→ this module)
 *     on EVERY scan, including pure-ATS scans, so import must be side-effect-free.
 *   - dotenv is loaded LAZILY inside the search functions (try/catch, never
 *     overrides already-set vars).
 *   - The DSN is validated/pinned (https + *.unipile.com) BEFORE the key is ever
 *     sent; the transport uses redirect:'error' and refuses cross-host requests.
 *   - The API key, DSN, and any returned PII are REDACTED from every thrown error.
 *
 * Exposes searchJobs() now and searchPeople() (Phase 5). Pure mappers (mapJob/
 * mapPerson) are exported for fixture-based unit tests; __setFetch/__resetFetch
 * let one guarded transport test exercise the real request builder without network.
 */

// Injectable for the guarded transport test (default: the global fetch).
let _fetch = (...a) => globalThis.fetch(...a);
export function __setFetch(fn) { _fetch = fn; }
export function __resetFetch() { _fetch = (...a) => globalThis.fetch(...a); }
// Injectable sleep so the 429/5xx backoff is testable without real delays.
let _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function __setSleep(fn) { _sleep = fn; }
export function __resetSleep() { _sleep = (ms) => new Promise((r) => setTimeout(r, ms)); }

export class UnipileError extends Error {
  constructor(message, code = 'unipile', status) {
    super(message);
    this.name = 'UnipileError';
    this.code = code;
    if (status) this.status = status;
  }
}

/** Strip the API key + DSN from a string so they can never reach a log or error. */
export function redact(str, { apiKey, dsn } = {}) {
  let s = String(str ?? '');
  if (apiKey) s = s.split(apiKey).join('***REDACTED-KEY***');
  if (dsn) s = s.split(dsn).join('***REDACTED-DSN***');
  // belt-and-braces: redact a header echo or a bearer-ish token if one ever appears.
  return s
    .replace(/(x-api-key)\s*[:=]\s*\S+/gi, '$1: ***')
    .replace(/(authorization)\s*[:=]\s*\S+/gi, '$1: ***');
}

// NaN-safe ISO → epoch ms (mirrors the ATS providers' toEpochMs).
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Map a Unipile JOBS item → canonical offer {title,url,company,location,postedAt}.
 * RUNTIME-VALIDATED 2026-06-18 against a live classic jobs capture: the date field
 * is `posted_at` (ISO-8601 UTC), NOT the OpenAPI-model `listed_at`; the envelope
 * key is `items`; `company` is a nested object with `.name`. We read `posted_at`
 * first and keep `listed_at` as a tolerant fallback. Tolerant of a string company.
 */
export function mapJob(item) {
  if (!item || typeof item !== 'object') return null;
  const company = typeof item.company === 'string'
    ? item.company
    : (item.company && item.company.name) || '';
  return {
    title: item.title || '',
    url: item.url || '',
    company,
    location: item.location || '',
    postedAt: toEpochMs(item.posted_at ?? item.listed_at),
  };
}

/**
 * Map a Unipile PEOPLE item → canonical contact {name,title,linkedinUrl,profileId,
 * publicIdentifier}. DOC-CONFIRMED fields (verbatim doc examples). In Sales Nav,
 * profile_url is a /sales/lead/ URL — prefer public_profile_url / public_identifier.
 */
export function mapPerson(item) {
  if (!item || typeof item !== 'object') return null;
  const name = item.name
    || [item.first_name, item.last_name].filter(Boolean).join(' ')
    || '';
  const title = (Array.isArray(item.current_positions) && item.current_positions[0] && item.current_positions[0].role)
    || item.headline
    || '';
  const profileUrlSafe = item.profile_url && !/\/sales\/lead\//.test(item.profile_url)
    ? item.profile_url : '';
  const linkedinUrl = item.public_profile_url
    || (item.public_identifier ? `https://www.linkedin.com/in/${item.public_identifier}` : '')
    || profileUrlSafe
    || '';
  return {
    name,
    title,
    linkedinUrl,
    profileId: item.id || '',
    publicIdentifier: item.public_identifier || '',
  };
}

/** Pull the items array out of a search envelope (people use `items`, jobs may use `data`). */
function envelopeItems(json) {
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}
function envelopeCursor(json) {
  return json?.cursor ?? json?.next_cursor ?? null;
}

/** Lazy config: dotenv (non-overriding) + required vars + DSN pin. Never logs secrets. */
async function loadConfig() {
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ override: false });
  } catch { /* dotenv optional — env may already be set */ }

  const dsn = process.env.UNIPILE_DSN;
  const apiKey = process.env.UNIPILE_API_KEY;
  const accountId = process.env.UNIPILE_ACCOUNT_ID;
  if (!dsn || !apiKey || !accountId) {
    throw new UnipileError(
      'Unipile is not configured — set UNIPILE_DSN, UNIPILE_API_KEY and UNIPILE_ACCOUNT_ID in .env (see .env.example).',
      'missing_credentials',
    );
  }
  const base = validateDsn(dsn); // throws if not https *.unipile.com
  return { base, apiKey, accountId, dsn };
}

/** Pin the DSN: must be https and a *.unipile.com host (port allowed). */
export function validateDsn(dsn) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(dsn) ? dsn : `https://${dsn}`);
  } catch {
    throw new UnipileError('UNIPILE_DSN is not a valid URL/host.', 'invalid_dsn');
  }
  if (u.protocol !== 'https:') {
    throw new UnipileError('UNIPILE_DSN must use https.', 'invalid_dsn');
  }
  if (!/(^|\.)unipile\.com$/i.test(u.hostname)) {
    // Do NOT interpolate the host — the DSN is redacted from every thrown error.
    throw new UnipileError('UNIPILE_DSN host is not an allowed unipile.com host.', 'invalid_dsn');
  }
  return `${u.protocol}//${u.host}`; // host includes the port
}

function mapErrCode(status, type) {
  if (status === 401) return 'disconnected';
  if (status === 403) {
    if (type && /feature_not_subscribed|subscription_required/.test(type)) return 'no_entitlement';
    return 'forbidden';
  }
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status === 404) return 'not_found';
  return 'http_error';
}

// Transient statuses worth a short backoff+retry (LinkedIn limits → 429/500 per
// the provider-limits docs; 503/504 are channel/timeout blips).
const RETRYABLE = new Set([429, 503, 504]);
const MAX_ATTEMPTS = 3;

/** Low-level authenticated request. Pins the host, attaches X-API-KEY, redirect:'error',
 *  and backs off + retries the transient 429/503/504 statuses. */
async function request(cfg, { method = 'GET', pathname, query = {}, body }) {
  const url = new URL(cfg.base + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  // Never send the key to a host other than the pinned DSN host.
  if (url.host !== new URL(cfg.base).host || url.protocol !== 'https:') {
    throw new UnipileError('Refusing to send credentials to a non-DSN host.', 'invalid_dsn');
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await _fetch(url.toString(), {
        method,
        headers: {
          'X-API-KEY': cfg.apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', // SSRF: never follow a server-side redirect with the key attached
      });
    } catch (e) {
      throw new UnipileError(redact(`Unipile request failed: ${e.message}`, cfg), 'network');
    }

    if (res.ok) return res.json();

    const text = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
    let type;
    try { type = JSON.parse(text)?.type; } catch { /* non-JSON body */ }
    lastErr = new UnipileError(
      redact(`Unipile HTTP ${res.status}${type ? ` (${type})` : ''}`, cfg),
      mapErrCode(res.status, type),
      res.status,
    );
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      // exponential backoff + jitter, spacing calls out to honour LinkedIn limits
      await _sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

// Memoize search-parameter id lookups for the process lifetime (a scan/contact run
// resolves the same handful of names — locations, companies — repeatedly).
const _paramIdCache = new Map();
/** Clear the search-parameter id cache (tests). */
export function __resetParameterCache() { _paramIdCache.clear(); }

/**
 * Resolve a NAME → its LinkedIn search-parameter id via the search-parameters route,
 * for a given `type` (e.g. 'LOCATION', 'COMPANY'). Returns the best match's id (exact
 * title wins, else the first result), a numeric input unchanged, or null. Never throws
 * — a failure returns null so the caller can omit that filter. Memoized by type:name.
 */
export async function resolveSearchParameterId(name, type, cfg) {
  if (name == null || String(name).trim() === '') return null;
  const raw = String(name).trim();
  if (/^\d+$/.test(raw)) return raw; // already an id
  const key = `${type}:${raw}`;
  if (_paramIdCache.has(key)) return _paramIdCache.get(key);
  try {
    const config = cfg || await loadConfig();
    const json = await request(config, {
      method: 'GET',
      pathname: '/api/v1/linkedin/search/parameters',
      query: { account_id: config.accountId, type, keywords: raw },
    });
    const items = Array.isArray(json?.items) ? json.items : [];
    const exact = items.find(it => it && typeof it.title === 'string' && it.title.toLowerCase() === raw.toLowerCase());
    const pick = exact || items[0];
    const id = pick && pick.id != null ? String(pick.id) : null;
    _paramIdCache.set(key, id);
    return id;
  } catch {
    return null; // transient failure — don't cache, just omit the filter
  }
}

/**
 * Resolve a location NAME → LinkedIn geo id (type=LOCATION). RUNTIME-VALIDATED
 * 2026-06-20: classic jobs filters by `region` (a single geo-id string ^\d+$); a
 * free location string 400s and the `location` array returns 0 results.
 */
export function resolveLocationId(name, cfg) { return resolveSearchParameterId(name, 'LOCATION', cfg); }

/**
 * Resolve a company NAME → LinkedIn company id (type=COMPANY). RUNTIME-VALIDATED
 * 2026-06-21: people search scopes by company id — classic `company:["<id>"]`,
 * sales_navigator `company:{include:["<id>"]}` — not by a keyword name match.
 */
export function resolveCompanyId(name, cfg) { return resolveSearchParameterId(name, 'COMPANY', cfg); }

/**
 * LinkedIn Jobs search (api=classic, category=jobs). Returns canonical offers.
 * @param {{keywords?:string, location?:string, limit?:number, maxPages?:number}} params
 * @returns {Promise<{offers:Array, cursor:string|null}>}
 */
export async function searchJobs({ keywords, location, limit = 25, maxPages = 2 } = {}) {
  limit = Math.max(1, Math.min(Number(limit) || 25, 50)); // jobs are Classic-only (doc cap ≤50)
  const cfg = await loadConfig();
  // classic jobs filters by `region` — a single geo-id string (^\d+$), NOT a free
  // location string (400s) nor the `location` array (accepted but returns 0).
  // Resolve a named location to its geo id; omit it (account-default geo) if it
  // can't be resolved, rather than sending an invalid param.
  let regionId;
  if (location != null && location !== '') {
    const id = await resolveLocationId(location, cfg);
    if (id) regionId = id;
  }
  const offers = [];
  let cursor = null;
  let pages = 0;
  do {
    const json = await request(cfg, {
      method: 'POST',
      pathname: '/api/v1/linkedin/search',
      query: { account_id: cfg.accountId, limit, cursor },
      body: { api: 'classic', category: 'jobs', keywords, ...(regionId ? { region: regionId } : {}) },
    });
    for (const it of envelopeItems(json)) {
      const o = mapJob(it);
      if (o && o.url) offers.push(o);
    }
    cursor = envelopeCursor(json);
    pages += 1;
  } while (cursor && pages < maxPages);
  return { offers, cursor };
}

/**
 * LinkedIn People search (decision-maker discovery). Prefers Sales Navigator; the
 * caller degrades on a no_entitlement error. Returns canonical contacts.
 * @param {{company?:string, keywords?:string, api?:'sales_navigator'|'classic', limit?:number, maxPages?:number}} params
 * @returns {Promise<{contacts:Array, cursor:string|null}>}
 */
export async function searchPeople({ company, keywords, api = 'sales_navigator', limit = 10, maxPages = 1 } = {}) {
  limit = Math.max(1, Math.min(Number(limit) || 10, api === 'classic' ? 50 : 100)); // doc caps
  const cfg = await loadConfig();
  // Structured company scoping: resolve the account name → LinkedIn company id and
  // filter people by CURRENT COMPANY, instead of jamming the name into the keywords
  // (which returns anyone who merely mentions it). RUNTIME-VALIDATED 2026-06-21 —
  // the shape differs by api: classic `company: ["<id>"]`, sales_navigator
  // `company: { include: ["<id>"] }`. If the company can't be resolved, fall back
  // to the keyword query so the search still degrades gracefully.
  let companyId = null;
  if (company) {
    try { companyId = await resolveCompanyId(company, cfg); } catch { companyId = null; }
  }
  const body = companyId
    ? {
      api, category: 'people', keywords: String(keywords || '').trim(),
      company: api === 'sales_navigator' ? { include: [companyId] } : [companyId],
    }
    : { api, category: 'people', keywords: [keywords, company].filter(Boolean).join(' ').trim() };

  const contacts = [];
  let cursor = null;
  let pages = 0;
  do {
    const json = await request(cfg, {
      method: 'POST',
      pathname: '/api/v1/linkedin/search',
      query: { account_id: cfg.accountId, limit, cursor },
      body,
    });
    for (const it of envelopeItems(json)) {
      const c = mapPerson(it);
      if (c && c.name) contacts.push(c);
    }
    cursor = envelopeCursor(json);
    pages += 1;
  } while (cursor && pages < maxPages);
  return { contacts, cursor };
}

/**
 * Confirm Sales Navigator entitlement on the connected account (the value-floor
 * gate). Reads GET /accounts/{id} and checks connection_params.im.premiumFeatures.
 * Returns { available, features } — never throws (returns available:false on error).
 */
export async function checkSalesNavigator() {
  let cfg;
  try { cfg = await loadConfig(); } catch (e) { return { available: false, features: [], error: e.code || 'error' }; }
  try {
    const acct = await request(cfg, { method: 'GET', pathname: `/api/v1/accounts/${encodeURIComponent(cfg.accountId)}` });
    const features = acct?.connection_params?.im?.premiumFeatures;
    const list = Array.isArray(features) ? features : [];
    return { available: list.includes('sales_navigator'), features: list };
  } catch (e) {
    return { available: false, features: [], error: e.code || 'error' };
  }
}
