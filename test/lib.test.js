// Unit tests on saved responses in test/fixtures/ (captured 2026-11-13). No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { EXCLUDED_TLDS, InputError, unsupportedReason, candidates, cleanDomain, normalizeInput, parseBootstrap, parseRdap, rdapBase, rdapUrl, tldOf, toItem } from '../src/lib.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-13T00:00:00Z');

test('cleanDomain: domains, URLs, emails, unicode, junk', () => {
    assert.equal(cleanDomain(' Example.COM '), 'example.com');
    assert.equal(cleanDomain('https://www.Example.com:8443/path?q=1#x'), 'example.com');
    assert.equal(cleanDomain('someone@example.org'), 'example.org');
    assert.equal(cleanDomain('shop.example.co.uk.'), 'shop.example.co.uk');
    assert.equal(cleanDomain('münchen.com'), 'xn--mnchen-3ya.com');
    assert.equal(cleanDomain('www.com'), 'www.com');
    for (const bad of ['', '   ', 'localhost', 'not a domain', '192.168.1.1', 'exa_mple.com', '-bad.com', 'a..com']) {
        assert.equal(cleanDomain(bad), null, bad);
    }
});

test('normalizeInput: cleaning, duplicates, invalid entries, limits', () => {
    const input = normalizeInput({ domains: ['Example.com', 'https://www.example.com/x', 'wikipedia.org', 'not a domain', ''] });
    assert.deepEqual(input.domains, [{ input: 'Example.com', domain: 'example.com' }, { input: 'wikipedia.org', domain: 'wikipedia.org' }]);
    assert.deepEqual(input.invalid, ['not a domain']);
    assert.equal(input.includeUnsupported, true);
    assert.deepEqual(normalizeInput({ domains: 'a.com, b.org\nc.net' }).domains.map((d) => d.domain), ['a.com', 'b.org', 'c.net']);
    for (const bad of [null, {}, { domains: [] }, { domains: [1] }, { domains: ['nope'] }]) {
        assert.throws(() => normalizeInput(bad), InputError, JSON.stringify(bad));
    }
    assert.throws(() => normalizeInput({ domains: Array.from({ length: 10_001 }, (_, i) => `d${i}.com`) }), /Too many domains/);
});

test('parseBootstrap: IANA file gives a server per TLD', () => {
    const map = parseBootstrap(fixture('bootstrap_dns.json'));
    assert.ok(map.size > 1000);
    assert.equal(map.get('com'), 'https://rdap.verisign.com/com/v1/');
    assert.equal(rdapBase('wikipedia.org', map), 'https://rdap.publicinterestregistry.org/rdap/');
    assert.equal(rdapBase('bbc.co.uk', map), 'https://rdap.nominet.uk/uk/');
    assert.equal(rdapBase('denic.de', map), null); // .de has no RDAP service in the file
    for (const base of map.values()) assert.match(base, /^https?:\/\/.+\/$/);
    assert.equal(rdapUrl(map.get('com'), 'google.com'), 'https://rdap.verisign.com/com/v1/domain/google.com');
    assert.throws(() => parseBootstrap('<html>'), /Unreadable RDAP bootstrap/);
    assert.equal(tldOf('a.b.co.uk'), 'uk');
});

test('unsupportedReason: .uk is excluded although it has RDAP; TLDs without RDAP; others pass', () => {
    const map = parseBootstrap(fixture('bootstrap_dns.json'));
    assert.ok(map.has('uk'));
    assert.ok(EXCLUDED_TLDS.has('uk'));
    for (const d of ['bbc.co.uk', 'nominet.uk', 'www2.bbc.co.uk']) assert.match(unsupportedReason(d, map), /\.uk is not supported/, d);
    assert.match(unsupportedReason('denic.de', map), /no RDAP service/);
    for (const d of ['google.com', 'wikipedia.org', 'web.dev', 'uk.com']) assert.equal(unsupportedReason(d, map), null, d);
    const item = toItem({ input: 'bbc.co.uk', domain: 'bbc.co.uk' }, { status: 'unsupported_tld', message: unsupportedReason('bbc.co.uk', map) }, 'T');
    assert.equal(item.status, 'unsupported_tld');
    assert.equal(item.registered, null);
    assert.equal(item.rdapServer, null);
});

test('candidates: the name, then its parents, never a public suffix', () => {
    assert.deepEqual(candidates('example.com'), ['example.com']);
    assert.deepEqual(candidates('mail.google.com'), ['mail.google.com', 'google.com']);
    assert.deepEqual(candidates('bbc.co.uk'), ['bbc.co.uk']);
    assert.deepEqual(candidates('www2.bbc.co.uk'), ['www2.bbc.co.uk', 'bbc.co.uk']);
    assert.deepEqual(candidates('co.uk'), ['co.uk']);
    assert.deepEqual(candidates('a.b.c.example.com'), ['a.b.c.example.com', 'c.example.com', 'example.com']);
});

test('parseRdap: google.com (Verisign)', () => {
    assert.deepEqual(parseRdap(fixture('google_com.json'), NOW), {
        domain: 'google.com',
        unicodeName: null,
        createdAt: '1997-09-15T04:00:00.000Z',
        updatedAt: '2019-09-09T15:39:04.000Z',
        expiresAt: '2028-09-14T04:00:00.000Z',
        daysUntilExpiry: 671,
        registrar: 'MarkMonitor Inc.',
        registrarIanaId: 292,
        statuses: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited', 'server delete prohibited', 'server transfer prohibited', 'server update prohibited'],
        nameservers: ['ns1.google.com', 'ns2.google.com', 'ns3.google.com', 'ns4.google.com'],
        dnssec: false,
    });
});

test('parseRdap: other registries (.org, .uk, .dev)', () => {
    const org = parseRdap(fixture('wikipedia_org.json'), NOW);
    assert.equal(org.domain, 'wikipedia.org');
    assert.equal(org.expiresAt, '2027-01-13T00:12:14.000Z');
    assert.equal(org.daysUntilExpiry, 61);
    assert.equal(org.registrarIanaId, 292);
    assert.ok(org.registrar);
    assert.deepEqual(org.nameservers, ['ns0.wikimedia.org', 'ns1.wikimedia.org', 'ns2.wikimedia.org']);

    const uk = parseRdap(fixture('bbc_co_uk.json'), NOW);
    assert.equal(uk.domain, 'bbc.co.uk');
    assert.equal(uk.createdAt, '1994-12-13T03:49:48.000Z');
    assert.equal(uk.expiresAt, '2034-12-13T03:49:48.000Z');
    const noExpiry = JSON.parse(fixture('bbc_co_uk.json'));
    noExpiry.events = noExpiry.events.filter((e) => e.eventAction !== 'expiration'); // some registries (.nl, .br) publish none
    assert.equal(parseRdap(JSON.stringify(noExpiry), NOW).expiresAt, null);
    assert.equal(parseRdap(JSON.stringify(noExpiry), NOW).daysUntilExpiry, null);
    assert.equal(uk.registrar, 'British Broadcasting Corporation');
    assert.equal(uk.registrarIanaId, null);
    assert.equal(uk.nameservers.length, 8);
    assert.ok(uk.nameservers.every((n) => !n.endsWith('.')));

    const dev = parseRdap(fixture('web_dev.json'), NOW);
    assert.equal(dev.domain, 'web.dev');
    assert.equal(dev.createdAt, '2018-10-29T15:57:39.435Z');
    assert.equal(dev.registrarIanaId, 292);
    assert.equal(dev.nameservers.length, 4);
});

test('parseRdap: no contact data in the output, junk throws', () => {
    for (const f of ['google_com.json', 'wikipedia_org.json', 'bbc_co_uk.json', 'web_dev.json']) {
        const text = JSON.stringify(parseRdap(fixture(f), NOW));
        assert.doesNotMatch(text, /@|registrant|email|tel:/i, f);
    }
    assert.throws(() => parseRdap(fixture('notfound_org.json')), /Unreadable RDAP answer/);
    assert.throws(() => parseRdap(''), /Unreadable RDAP answer/);
});

test('toItem: the four outcomes', () => {
    const entry = { input: 'https://mail.google.com/', domain: 'mail.google.com' };
    const at = '2026-11-13T00:00:00.000Z';
    const reg = toItem(entry, { status: 'registered', domain: 'google.com', data: parseRdap(fixture('google_com.json'), NOW), rdapServer: 'https://rdap.verisign.com/com/v1/' }, at);
    assert.equal(reg.input, 'https://mail.google.com/');
    assert.equal(reg.domain, 'google.com');
    assert.equal(reg.tld, 'com');
    assert.equal(reg.registered, true);
    assert.equal(reg.registrar, 'MarkMonitor Inc.');
    assert.equal(reg.rdapServer, 'https://rdap.verisign.com/com/v1/');
    assert.equal(reg.checkedAt, at);

    const free = toItem({ input: 'zzz.com', domain: 'zzz.com' }, { status: 'not_found', domain: 'zzz.com', rdapServer: 'https://rdap.verisign.com/com/v1/' }, at);
    assert.equal(free.registered, false);
    assert.equal(free.status, 'not_found');
    assert.equal(free.createdAt, null);
    assert.deepEqual(free.nameservers, []);
    assert.deepEqual(Object.keys(free).sort(), Object.keys(reg).sort()); // same columns either way

    const unsupported = toItem({ input: 'denic.de', domain: 'denic.de' }, { status: 'unsupported_tld', message: 'x' }, at);
    assert.equal(unsupported.registered, null);
    assert.equal(unsupported.rdapServer, null);
    assert.equal(unsupported.message, 'x');
    assert.equal(toItem({ input: 'm', domain: 'xn--mnchen-3ya.com' }, { status: 'not_found', domain: 'xn--mnchen-3ya.com' }, at).unicodeName, 'münchen.com');
    assert.equal(reg.unicodeName, null);
    assert.deepEqual(Object.keys(reg).slice(0, 5), ['input', 'domain', 'tld', 'status', 'registered']);
    assert.equal(toItem(entry, { status: 'error', message: 'HTTP 503', rdapServer: 'b' }, at).registered, null);
});
