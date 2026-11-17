import { domainToUnicode } from 'node:url';

// Pure functions: input checks, the IANA bootstrap map, request URLs and parsing of RDAP domain answers.
// No network and no Apify SDK here, so everything in this file is unit-tested on saved fixtures.

export const MAX_DOMAINS = 1000; // kept low on purpose: registries ask clients not to send high volumes
export const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
export const MAX_CANDIDATES = 3; // at most this many requests per input name

export class InputError extends Error {}

// Second-level labels under which country registries sell names (example.co.uk): never strip a name down to one of these.
const PUBLIC_SECOND_LEVELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne', 'go', 'gob', 'nom', 'sch', 'mil', 'ltd', 'plc', 'me', 'info']);

/**
 * Cleans one entry into a domain name: accepts a domain, a URL or an email-style "x@domain".
 * Returns the lowercase ASCII (punycode) name without "www.", or null when it is not a domain.
 */
export function cleanDomain(entry) {
    let raw = String(entry ?? '').trim().toLowerCase();
    if (!raw) return null;
    raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^/@\s]*@/, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    if (!raw) return null;
    let host;
    try {
        host = new URL(`http://${raw}`).hostname; // converts unicode names to punycode
    } catch {
        return null;
    }
    if (/^www\.[^.]+\../.test(host)) host = host.slice(4); // "www.example.com" -> "example.com", but "www.com" stays
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) return null;
    return host;
}

/** Validates the raw Actor input and fills defaults. Throws InputError with a message a user can act on. */
export function normalizeInput(raw) {
    const input = raw ?? {};
    let { domains } = input;
    if (typeof domains === 'string') domains = domains.split(/[\r\n,;]+/);
    if (!Array.isArray(domains)) {
        throw new InputError('Input field "domains" is required: a list of domain names, e.g. ["example.com", "wikipedia.org"].');
    }
    const cleaned = [];
    const invalid = [];
    const seen = new Set();
    for (const entry of domains) {
        const value = entry && typeof entry === 'object' ? entry.url : entry; // also accepts [{ url }] (Apify request list)
        if (typeof value !== 'string') throw new InputError('Every entry of "domains" must be a text string.');
        if (!value.trim()) continue;
        const domain = cleanDomain(value);
        if (!domain) {
            invalid.push(value.trim());
            continue;
        }
        if (seen.has(domain)) continue;
        seen.add(domain);
        cleaned.push({ input: value.trim(), domain });
    }
    if (cleaned.length === 0) {
        throw new InputError(invalid.length ? `None of the entries in "domains" is a domain name (first: "${invalid[0]}").` : 'Input field "domains" is empty: give at least one domain name.');
    }
    if (cleaned.length > MAX_DOMAINS) throw new InputError(`Too many domains: ${cleaned.length}. The limit is ${MAX_DOMAINS} per run.`);
    return {
        domains: cleaned,
        invalid,
        includeUnsupported: input.includeUnsupported !== false,
        proxyConfiguration: input.proxyConfiguration ?? null,
    };
}

/** Builds the TLD -> RDAP base URL map from IANA's bootstrap file (https preferred, always ending in "/"). */
export function parseBootstrap(body) {
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw new Error('Unreadable RDAP bootstrap file');
    }
    if (!data || !Array.isArray(data.services)) throw new Error('Unreadable RDAP bootstrap file');
    const map = new Map();
    for (const [tlds, urls] of data.services) {
        if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue;
        let base = urls.find((u) => /^https:/i.test(u)) ?? urls[0];
        if (!base.endsWith('/')) base += '/';
        for (const tld of tlds) map.set(String(tld).toLowerCase(), base);
    }
    return map;
}

export const tldOf = (domain) => domain.slice(domain.lastIndexOf('.') + 1);

/** The RDAP server for a domain, or null when its TLD has no RDAP service. */
export const rdapBase = (domain, bootstrap) => bootstrap.get(tldOf(domain)) ?? null;

// TLDs this Actor does not query although they have RDAP: the registry's terms forbid commercial reuse of the answers.
export const EXCLUDED_TLDS = new Set(['uk']);

/** Why a domain is not looked up (a message for the user), or null when it can be. */
export function unsupportedReason(domain, bootstrap) {
    const tld = tldOf(domain);
    if (EXCLUDED_TLDS.has(tld)) return `.${tld} is not supported: the registry's terms do not allow this kind of use of its RDAP answers.`;
    if (!bootstrap.has(tld)) return `The .${tld} registry has no RDAP service.`;
    return null;
}

export const rdapUrl =(base, domain) => `${base}domain/${encodeURIComponent(domain)}`;

/**
 * The names to ask for, most specific first: the name itself, then its parents down to two labels
 * ("shop.example.com" -> "example.com"), never a bare public suffix such as "co.uk".
 */
export function candidates(domain) {
    const labels = domain.split('.');
    const out = [];
    for (let i = 0; labels.length - i >= 2; i++) {
        const rest = labels.slice(i);
        if (rest.length === 2 && rest[1].length === 2 && PUBLIC_SECOND_LEVELS.has(rest[0]) && out.length > 0) break;
        out.push(rest.join('.'));
    }
    // A deep name: ask for the name itself, then only the shortest parents.
    return out.length > MAX_CANDIDATES ? [out[0], ...out.slice(-(MAX_CANDIDATES - 1))] : out;
}

const eventDate = (events, ...actions) => {
    for (const action of actions) {
        const e = (events ?? []).find((x) => String(x?.eventAction ?? '').toLowerCase() === action);
        if (e?.eventDate) {
            const d = new Date(e.eventDate);
            if (!Number.isNaN(d.getTime())) return d.toISOString();
        }
    }
    return null;
};

const vcardValue = (entity, field) => {
    const row = (entity?.vcardArray?.[1] ?? []).find((r) => Array.isArray(r) && r[0] === field);
    return typeof row?.[3] === 'string' && row[3].trim() ? row[3].trim() : null;
};

const cleanHost = (name) => (typeof name === 'string' && name ? name.toLowerCase().replace(/\.$/, '') : null);

/**
 * Reads one RDAP domain answer. Only registry facts are kept: dates, registrar, status, nameservers, DNSSEC.
 * Registrant, admin and technical contacts are never read. `now` is epoch milliseconds.
 */
export function parseRdap(body, now = Date.now()) {
    let d;
    try {
        d = JSON.parse(body);
    } catch {
        throw new Error('Unreadable RDAP answer');
    }
    if (!d || d.objectClassName !== 'domain') throw new Error('Unreadable RDAP answer');

    const registrar = (d.entities ?? []).find((e) => Array.isArray(e?.roles) && e.roles.includes('registrar'));
    const ianaId = (registrar?.publicIds ?? []).find((p) => /iana registrar id/i.test(p?.type ?? ''))?.identifier;
    const expiresAt = eventDate(d.events, 'expiration');
    return {
        domain: cleanHost(d.ldhName),
        unicodeName: typeof d.unicodeName === 'string' && d.unicodeName.toLowerCase().replace(/\.$/, '') !== cleanHost(d.ldhName) ? d.unicodeName : null,
        createdAt: eventDate(d.events, 'registration'),
        updatedAt: eventDate(d.events, 'last changed'),
        expiresAt,
        daysUntilExpiry: expiresAt ? Math.floor((Date.parse(expiresAt) - now) / 86_400_000) : null,
        registrar: vcardValue(registrar, 'fn') ?? (registrar && /^\d+$/.test(String(registrar.handle ?? '')) ? null : registrar?.handle ?? null),
        registrarIanaId: ianaId != null && /^\d+$/.test(String(ianaId)) ? Number(ianaId) : null,
        statuses: [...new Set((d.status ?? []).map((s) => String(s).toLowerCase()))],
        nameservers: [...new Set((d.nameservers ?? []).map((n) => cleanHost(n?.ldhName)).filter(Boolean))],
        dnssec: typeof d.secureDNS?.delegationSigned === 'boolean' ? d.secureDNS.delegationSigned : null,
    };
}

const EMPTY = { unicodeName: null, createdAt: null, updatedAt: null, expiresAt: null, daysUntilExpiry: null, registrar: null, registrarIanaId: null, statuses: [], nameservers: [], dnssec: null };

/**
 * One dataset item. `result` is one of:
 *   { status: 'registered', data, rdapServer }   data from parseRdap
 *   { status: 'not_found', rdapServer }          the registry has no such name
 *   { status: 'unsupported_tld' }                the TLD has no RDAP service
 *   { status: 'error', message, rdapServer }     the registry could not be reached
 */
export function toItem({ input, domain }, result, checkedAt) {
    const registered = result.status === 'registered' ? true : result.status === 'not_found' ? false : null;
    const data = result.status === 'registered' ? result.data : EMPTY;
    // The name the answer is about: for "shop.example.com" that is "example.com".
    const answered = result.domain || domain;
    const item = { input, domain: answered, tld: tldOf(domain), status: result.status, registered, ...data };
    item.domain = answered;
    const unicode = domainToUnicode(answered);
    item.unicodeName = unicode && unicode !== answered ? unicode : null;
    item.rdapServer = result.rdapServer ?? null;
    if (result.message) item.message = result.message;
    item.checkedAt = checkedAt;
    return item;
}
