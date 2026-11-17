// Domain RDAP Lookup: registration facts for many domains from the registries' official RDAP servers, one item per domain.
import { Actor, log } from 'apify';
import { ProxyAgent, fetch } from 'undici';

import { BOOTSTRAP_URL, InputError, candidates, normalizeInput, parseBootstrap, parseRdap, rdapBase, rdapUrl, toItem, unsupportedReason } from './lib.js';

const EVENT = 'domain';
const USER_AGENT = 'domain-rdap-lookup/0.1 (Apify Actor; RDAP client)';
const RETRIES = 4;
const TIMEOUT_MS = 30_000;
const SERVER_CONCURRENCY = 8; // registries asked at the same time
const PER_SERVER_CONCURRENCY = 2; // parallel requests to one registry
const PER_SERVER_DELAY_MS = 150; // pause after each request to the same registry
const PUSH_BATCH = 50;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** GET with retries and backoff on network errors, 429 and 5xx (honours Retry-After). Returns { status, body }; 404 is an answer, not an error. */
async function request(url, dispatcher) {
    let lastError;
    let wait = 0;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt > 0) await sleep(Math.max(wait, Math.min(1000 * 2 ** (attempt - 1), 15_000)) + Math.random() * 500);
        wait = 0;
        try {
            stats.requests++;
            const res = await fetch(url, {
                dispatcher,
                headers: { 'user-agent': USER_AGENT, accept: 'application/rdap+json, application/json' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel();
                const retryAfter = Number(res.headers.get('retry-after'));
                if (Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.min(retryAfter * 1000, 30_000);
                lastError = new Error(`HTTP ${res.status}`);
                continue;
            }
            if (res.status === 404) {
                await res.body?.cancel();
                return { status: 404, body: '' };
            }
            if (!res.ok) {
                await res.body?.cancel();
                const err = new Error(`HTTP ${res.status}`);
                err.permanent = true;
                throw err;
            }
            return { status: res.status, body: await res.text() };
        } catch (err) {
            if (err.permanent) throw err;
            lastError = err;
        }
    }
    throw lastError;
}

/** Runs fn over items with a fixed number of workers. */
async function eachLimit(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    }));
}

/** Asks the registry about one name (and, for a subdomain, its parents). */
async function lookup(entry, base, dispatcher) {
    const names = candidates(entry.domain);
    try {
        for (const name of names) {
            const res = await request(rdapUrl(base, name), dispatcher);
            await sleep(PER_SERVER_DELAY_MS);
            if (res.status === 404) continue;
            return { status: 'registered', domain: name, data: parseRdap(res.body), rdapServer: base };
        }
        return { status: 'not_found', domain: names[names.length - 1], rdapServer: base };
    } catch (err) {
        return { status: 'error', message: `The registry could not be read: ${err.message}`, rdapServer: base };
    }
}

const stats = { domains: 0, requests: 0, registered: 0, notFound: 0, unsupportedTld: 0, errors: 0, charged: 0 };

await Actor.init();

let input;
try {
    input = normalizeInput(await Actor.getInput());
} catch (err) {
    if (err instanceof InputError) await Actor.fail(`Invalid input: ${err.message}`);
    throw err;
}
stats.domains = input.domains.length;
if (input.invalid.length) log.warning(`${input.invalid.length} entries are not domain names and were skipped, e.g. "${input.invalid[0]}".`);

const proxyConfiguration = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : undefined;
const proxyUrl = await proxyConfiguration?.newUrl();
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

let bootstrap;
try {
    bootstrap = parseBootstrap((await request(BOOTSTRAP_URL, dispatcher)).body);
} catch (err) {
    await Actor.fail(`IANA's list of RDAP servers could not be loaded (${err.message}). Nothing was charged for results. Try again.`);
}

const chargingManager = Actor.getChargingManager();
const budgetNow = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT);
const budget = Number.isFinite(budgetNow) ? budgetNow : Infinity;
let reserved = 0; // lookups started or finished that are (or may be) charged
let limitReached = false;

// Charged results are saved in batches, one push at a time.
let buffer = [];
let pushing = Promise.resolve();
const flush = () => {
    const batch = buffer;
    buffer = [];
    if (batch.length === 0) return pushing;
    pushing = pushing.then(async () => {
        const charge = await Actor.pushData(batch, EVENT);
        stats.charged += batch.length;
        if (charge?.eventChargeLimitReached) limitReached = true;
    });
    return pushing;
};

const free = []; // results that are not charged: unsupported TLDs and errors
const groups = new Map();
for (const entry of input.domains) {
    const reason = unsupportedReason(entry.domain, bootstrap);
    if (reason) {
        stats.unsupportedTld++;
        if (input.includeUnsupported) free.push(toItem(entry, { status: 'unsupported_tld', message: reason }, new Date().toISOString()));
        continue;
    }
    const base = rdapBase(entry.domain, bootstrap);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(entry);
}

let done = stats.unsupportedTld;
await eachLimit([...groups.entries()], SERVER_CONCURRENCY, async ([base, entries]) => {
    await eachLimit(entries, PER_SERVER_CONCURRENCY, async (entry) => {
        if (limitReached) return;
        if (reserved >= budget) {
            limitReached = true;
            return;
        }
        reserved++;
        const result = await lookup(entry, base, dispatcher);
        const item = toItem(entry, result, new Date().toISOString());
        if (result.status === 'error') {
            reserved--;
            stats.errors++;
            free.push(item);
            log.warning(`${entry.domain}: ${result.message}`);
        } else {
            if (result.status === 'registered') stats.registered++;
            else stats.notFound++;
            buffer.push(item);
            if (buffer.length >= PUSH_BATCH) await flush();
        }
        done++;
        if (done % 50 === 0) await Actor.setStatusMessage(`${done}/${stats.domains} domains checked`);
    });
});
await flush();
await pushing;
if (free.length > 0) await Actor.pushData(free); // saved without a charge

await Actor.setValue('SUMMARY', { ...stats, invalidEntries: input.invalid.slice(0, 100), rdapServers: groups.size, limitReached });

if (limitReached) log.info('The spending limit for this run was reached; stopped early with the results saved so far.');
const looked = stats.registered + stats.notFound + stats.errors;
if (looked > 0 && stats.errors === looked) {
    await Actor.fail('None of the registries could be reached. Nothing was charged for results. Try again, or set a proxy in the input.');
}
const notes = [
    stats.unsupportedTld ? `${stats.unsupportedTld} on unsupported TLDs (not charged)` : null,
    stats.errors ? `${stats.errors} failed (not charged)` : null,
    limitReached ? 'spending limit reached' : null,
].filter(Boolean);
await Actor.exit(`Done: ${stats.registered} registered, ${stats.notFound} not found, of ${stats.domains} domains${notes.length ? ` (${notes.join(', ')})` : ''}.`);
