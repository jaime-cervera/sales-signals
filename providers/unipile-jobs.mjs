// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Unipile LinkedIn Jobs provider — the PRIMARY buying-signal discovery engine (R3).
//
// Modeled as a single `job_boards`-style entry: one signals.yml entry
// (`provider: unipile-jobs`) → one fetch() → MANY companies (not one entry per
// company). Unlike the ATS providers, `ctx` carries no auth, so this provider
// obtains credentials + the per-tenant DSN by importing lib/unipile-client.mjs
// directly (which is INERT at import — safe to load on every scan).
//
// Graceful degradation (the whole point of the fallback design): any failure
// (missing creds, no Sales Nav, 429, network) is logged REDACTED and returns []
// so the scan continues with the WebSearch + zero-token ATS sources.

import { searchJobs } from '../lib/unipile-client.mjs';

// Validate a result URL the way greenhouse validates its result hosts: https +
// a LinkedIn host. Anything else is dropped (defense against a tampered payload).
function isSafeJobUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(u.hostname);
}

/** @type {Provider} */
export default {
  id: 'unipile-jobs',

  async fetch(entry, _ctx) {
    const keywords = entry.query || entry.keywords
      || (entry.title_filter && Array.isArray(entry.title_filter.positive)
        ? entry.title_filter.positive.join(' OR ') : '');
    try {
      const { offers } = await searchJobs({
        keywords,
        location: entry.location,
        limit: entry.limit || 25,
        maxPages: entry.max_pages || 2,
      });
      return offers
        .filter(o => isSafeJobUrl(o.url))
        .map(o => ({ ...o, company: o.company || entry.name || 'Unknown' }));
    } catch (err) {
      // err.message is already redacted by lib/unipile-client.mjs.
      console.error(`⚠️  unipile-jobs: ${err.message} — skipping Unipile (scan continues with other sources)`);
      return [];
    }
  },
};
