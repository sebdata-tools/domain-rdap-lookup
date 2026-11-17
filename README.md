# WHOIS Domain Lookup via RDAP: Created, Expiry, Registrar, DNS

Give this bulk WHOIS domain lookup a list of domains and get back, for each one: **is it registered, when was it created, when
does it expire, who is the registrar, what are its status codes and nameservers.** The answers come
from the registries' own **RDAP** servers, the official successor of WHOIS, so they arrive as clean
structured data instead of free text that has to be guessed at.

- **Bulk:** up to 1,000 domains per run, across any mix of TLDs.
- **URLs accepted:** paste `https://www.example.com/page` or `shop.example.com`; the registered
  domain is worked out for you.
- **No contact data:** registrant, admin and technical contacts are never read or saved.
- **Fast:** plain HTTP. In our test 150 domains took 21 seconds.

Open source (MIT). Written in Node.js on the Apify SDK; it runs on your own machine without an Apify account.

## Run it locally

Needs Node.js 20 or later.

```
git clone https://github.com/sebdata-tools/domain-rdap-lookup.git
cd domain-rdap-lookup
npm install
node test/run_local.mjs @input.json
```

`input.json` is a file you write; the fields are under "Input example" below. `run_local.mjs` runs
`src/main.js` with local storage, prints a summary and the first rows, and leaves all rows in
`storage/items.json` (one file per row is in `storage/datasets/default/`). Each run wipes `storage/` first.

Where the sections below mention a price or what is charged, that applies to the hosted version only:
run locally, nothing is charged.

## Input example

```json
{
    "domains": ["github.com", "wikipedia.org", "https://www.lemonde.fr/international", "a-name-nobody-registered-1234.com"]
}
```

| Field | What it does | Default |
|---|---|---|
| `domains` | Domain names or URLs, up to 1,000. Required. | |
| `includeUnsupported` | List domains on unsupported TLDs (status `unsupported_tld`, not charged). | `true` |
| `proxyConfiguration` | Optional proxy. Normally not needed. | none |

## Output example

```json
{
    "input": "github.com",
    "domain": "github.com",
    "tld": "com",
    "status": "registered",
    "registered": true,
    "unicodeName": null,
    "createdAt": "2007-10-09T18:20:50.000Z",
    "updatedAt": "2026-09-07T09:22:52.000Z",
    "expiresAt": "2028-10-09T18:20:50.000Z",
    "daysUntilExpiry": 695,
    "registrar": "MarkMonitor Inc.",
    "registrarIanaId": 292,
    "statuses": ["client delete prohibited", "client transfer prohibited", "client update prohibited"],
    "nameservers": ["dns1.p08.nsone.net", "dns2.p08.nsone.net", "dns3.p08.nsone.net", "dns4.p08.nsone.net"],
    "dnssec": false,
    "rdapServer": "https://rdap.verisign.com/com/v1/",
    "checkedAt": "2026-11-14T00:43:23.080Z"
}
```

(The nameserver list is shortened here.) A domain the registry does not know comes back with the
same fields, `"status": "not_found"`, `"registered": false` and empty values. Export the dataset as
JSON, CSV or Excel, or read it through the Apify API.

## The four statuses

| `status` | `registered` | Meaning | Charged |
|---|---|---|---|
| `registered` | `true` | The registry has a record for the domain. | yes |
| `not_found` | `false` | The registry has no record. Usually the name is free to register, but registries also answer this way for some reserved or blocked names, so confirm with a registrar before relying on it. | yes |
| `unsupported_tld` | `null` | The TLD's registry runs no RDAP service, or the TLD is not supported (.uk). The `message` field says which. | no |
| `error` | `null` | The registry did not answer after several tries. | no |

## Good to know

- **Which TLDs work:** every TLD in IANA's RDAP list, loaded fresh on each run: all generic TLDs
  (.com, .net, .org, .app, .dev, .xyz, .ai...) and many country TLDs (.fr, .nl, .ca, .au, .br, .in...). Some
  country registries have no RDAP yet, among them .de, .io, .co, .ch, .es, .it, .jp and .eu
  (checked November 2026).
- **.uk is not supported.** The .uk registry's terms do not allow this kind of use of its answers,
  so .uk names are listed as `unsupported_tld` and not charged.
- **Fields differ by registry.** Some country registries publish no expiry date or no registrar;
  those fields are then `null`.
- **Subdomains:** for `shop.example.com` the Actor asks for the name, then for `example.com`, and
  reports the registered domain in `domain`. The `input` field keeps what you typed.
- **Internationalized names** are accepted in either form; `domain` holds the ASCII form and
  `unicodeName` the readable one.
- **Polite by design.** Each registry is asked at most two questions at a time with a pause between
  them, and a run is capped at 1,000 domains. Registries throttle clients that send too much; a
  throttled lookup is retried, then reported as `error` and not charged.
- **Registry terms apply to you.** Registries publish this data for information about domain
  registrations. Their terms forbid using it for unsolicited advertising or to contact registrants in
  bulk; this Actor does not return contact data at all.
- **Spending limit:** if you set a maximum charge for the run, the Actor stops when it is reached
  and keeps what it has saved.

## Typical uses

Watching your own portfolio for expiry dates, checking a list of name ideas for availability,
verifying the age of domains in a lead or link list, spotting registrar or nameserver changes,
brand-protection checks, giving an agent a reliable "is this domain registered?" tool.

## Tests

`src/lib.js` holds the pure logic (input checks, URL building, parsing); `src/main.js` holds the network
and storage code. The unit tests in `test/lib.test.js` run `lib.js` against saved answers of the live
sources. Those files are copies of third-party pages and API answers and are **not included in this
repository**, so `npm test` says so and skips. To run them, save your own captures under `test/fixtures/`
with the file names the test reads. The live check is `node test/run_local.mjs @input.json`.

## Hosted version

To run it in the cloud, on a schedule or through an API, without installing anything: [WHOIS Domain Lookup via RDAP: Created, Expiry, Registrar, DNS on Apify](https://apify.com/sebdata/domain-rdap-lookup) (paid per result).

## Who made this

This tool and its code were written by an AI agent (Anthropic's Claude), under a human account owner. Problems and wrong results: open an issue. MIT licence, no warranty.
