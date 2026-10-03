# Guide

- [The interface](#the-interface)
- [Names](#names)
- [Errors, and what a mail server makes of them](#errors-and-what-a-mail-server-makes-of-them)
- [On node:dns](#on-nodedns)
- [In specs: the fixture](#in-specs-the-fixture)
- [Caching](#caching)
- [Answering the interface yourself](#answering-the-interface-yourself)

## The interface

A `Resolver` has five methods, one per record type a mail server reads:

| method | answers | read by |
| --- | --- | --- |
| `mx(domain)` | `{ exchange, priority, ttl }[]`, lowest priority first | the SMTP client (RFC 5321 §5.1), MTA-STS |
| `txt(name)` | `{ text, ttl }[]`, each record's strings joined | SPF (RFC 7208), DKIM keys (RFC 6376), DMARC (RFC 7489), MTA-STS |
| `a(name)` | `{ address, ttl }[]` | the SMTP client, SPF's `a` and `mx` mechanisms |
| `aaaa(name)` | `{ address, ttl }[]` | the same, over IPv6 |
| `ptr(address)` | `{ name, ttl }[]` | the Received field, SPF's `ptr`, a client's identity |

Each one answers with **at least one record or throws a `DnsError`**. An
empty array is never an answer, so code can read `records[0]` after a
successful call without a check for none.

```ts
import { nodeResolver } from '@bumail/dns';

const dns = nodeResolver();
const [first] = await dns.mx('example.org');
first?.exchange; // the host to connect to first
```

An MX `exchange` and a PTR `name` come lowercase with no trailing dot. A
null MX (RFC 7505), `0 .`, comes back as one record whose `exchange` is
the empty string:

```ts
import { isNullMx } from '@bumail/dns';

const records = await dns.mx('example.com');
if (isNullMx(records)) {
	// the domain says it takes no mail: bounce at once, no A/AAAA fallback
}
```

TXT records are long strings cut into character-strings of 255 bytes at
most. `txt()` joins each record's pieces with nothing between them, as
SPF (RFC 7208 §3.3) and DKIM (RFC 6376 §3.6.2.2) require. Several records
stay several:

```ts
const records = await dns.txt('example.com');
const spf = records.filter((record) => record.text.startsWith('v=spf1'));
// more than one is SPF's permerror (RFC 7208 §4.5)
```

## Names

Every resolver normalises a name the same way before asking. It
lowercases it, drops one trailing dot, and turns an international name
into its A-labels:

```ts
import { normalizeName } from '@bumail/dns';

normalizeName('Example.COM.'); // 'example.com'
normalizeName('bücher.example'); // 'xn--bcher-kva.example'
normalizeName('_dmarc.Example.com'); // '_dmarc.example.com': underscores are kept
```

A label is 1 to 63 letters, digits, hyphens or underscores, and does not
start or end with a hyphen. A name is 253 characters at most. Anything
else throws `INVALID_NAME` **before any query**: a space, a control
character, an empty label, `*`, an address given where a name is
expected. So a name taken from a message (a `MAIL FROM` domain, a DKIM
`d=` tag) cannot smuggle anything into a query. `ptr()` takes an IPv4 or
IPv6 address instead, and refuses anything else the same way.

## Errors, and what a mail server makes of them

| code | means | SPF / DKIM / DMARC | SMTP client |
| --- | --- | --- | --- |
| `NOT_FOUND` | the DNS answered: no such name, or no record of that type | `none` (no record), or `permerror` where a record was required | MX: fall back to A/AAAA (RFC 5321 §5.1); A/AAAA: bounce |
| `TEMPORARY` | the server failed, refused, or answered garbage | `temperror` | defer and retry |
| `TIMEOUT` | no answer within `timeout` × `tries` | `temperror` | defer and retry |
| `INVALID_NAME` | the name could not be a host name; nothing was sent | `permerror` | bounce |
| `INVALID_OPTION` | a resolver was built with an option it cannot take | a bug to fix | a bug to fix |

`isTemporary(error)` is true for `TEMPORARY`, for `TIMEOUT`, and for
anything that is not a `DnsError` at all. It is the "may I retry later?"
question in one call:

```ts
import { DnsError, isTemporary } from '@bumail/dns';

async function dmarcRecord(domain: string) {
	try {
		const records = await dns.txt(`_dmarc.${domain}`);
		return records.find((record) => record.text.startsWith('v=DMARC1'));
	} catch (error) {
		if (isTemporary(error)) throw error; // temperror: the caller defers
		if (error instanceof DnsError && error.code === 'NOT_FOUND') return undefined; // none
		throw error;
	}
}
```

`NOT_FOUND` does not say whether the name exists. Bun's `node:dns`
reports NXDOMAIN and NODATA alike as `ENOTFOUND`, so no resolver on it can
tell them apart. A mail server does not need to: SPF counts both as a void
lookup (RFC 7208 §4.6.4), DMARC reads both as "no policy", and the SMTP
client's fallback from MX to A gives the same result either way, because
the A query then fails too for a name that does not exist.

## On node:dns

```ts
const dns = nodeResolver({
	servers: ['1.1.1.1', '[2606:4700:4700::1111]:53'], // the system's when left out
	timeout: 3000, // milliseconds per try; node:dns's default (5000) when left out
	tries: 2, // node:dns's default (4) when left out
	assumedTtl: 300, // seconds, for MX, TXT and PTR
});
```

`node:dns` reports the TTL of A and AAAA answers, and `nodeResolver`
passes it on. It reports none for MX, TXT or PTR. Asking ANY to learn it
is deprecated (RFC 8482) and, on Bun, times out. So those three answers
carry `assumedTtl`, which is what a cache keeps them for. Lower it if you
publish records that change often and read them back; raise it to query
less.

`node:dns` error codes map onto `DnsError`:

| node:dns | `DnsError` |
| --- | --- |
| `ENOTFOUND`, `ENODATA` | `NOT_FOUND` |
| `ETIMEOUT` | `TIMEOUT` |
| `EBADNAME` | `INVALID_NAME` |
| anything else (`ESERVFAIL`, `EREFUSED`, `ECONNREFUSED`, `EBADRESP`…) | `TEMPORARY` |

To query something other than `node:dns`, give a `backend` with the five
methods `nodeResolver` calls. That is how its own specs run without a
network:

```ts
import type { DnsBackend } from '@bumail/dns';

const backend: DnsBackend = {
	resolve4: async () => [{ address: '192.0.2.1', ttl: 60 }],
	resolve6: async () => [],
	resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
	resolveTxt: async () => [['v=spf1 -all']],
	reverse: async () => ['mail.example.com'],
};
const fake = nodeResolver({ backend });
```

## In specs: the fixture

A spec never queries the Internet: its answer would change, and so would
the spec's result. `fixtureResolver` answers from an object. The
fixture's names are normalised like any query, PTR records are keyed by
address, and a TTL left out is 300:

```ts
import { fixtureResolver } from '@bumail/dns';

const dns = fixtureResolver({
	'example.com': {
		mx: [
			{ exchange: 'mx1.example.com', priority: 10 },
			{ exchange: 'mx2.example.com', priority: 20, ttl: 60 },
		],
		txt: [
			'v=spf1 include:_spf.example.net -all',
			['v=DKIM1; k=rsa; p=MIIB', 'IjANBg…'], // one record, two character-strings
		],
		a: ['192.0.2.1', { address: '192.0.2.2', ttl: 30 }],
	},
	'192.0.2.1': { ptr: ['mail.example.com'] },
	'broken.example': { error: 'TEMPORARY' }, // every type fails
	'flaky.example': { txt: 'TIMEOUT', a: ['192.0.2.9'] }, // one type fails
});
```

A name or a type the fixture does not hold is `NOT_FOUND`. `queries`
lists every query made, in order, which is how a spec checks SPF's limit
of ten DNS lookups (RFC 7208 §4.6.4) or that a cache saved one:

```ts
await dns.txt('example.com');
dns.queries; // [{ type: 'txt', name: 'example.com' }]
```

## Caching

`cachedResolver` wraps any resolver:

```ts
import { cachedResolver, nodeResolver } from '@bumail/dns';

const dns = cachedResolver(nodeResolver(), {
	maxEntries: 1000,
	maxTtl: 86_400,
	negativeTtl: 300,
});
```

- **Positive answers** are kept for the lowest TTL among their records,
  capped at `maxTtl`. An answer whose TTL is 0 is not kept. A cached
  answer comes back with the TTL it has left, so a cache in front of
  another cache does not stretch it.
- **`NOT_FOUND`** is kept for `negativeTtl` (RFC 2308). The SOA minimum
  that should bound it is not something `node:dns` returns, so it is this
  fixed time; 0 keeps none.
- **`TEMPORARY` and `TIMEOUT` are never kept.** The next query asks again,
  so a server that was down for a second is not remembered as down for
  five minutes.
- **Memory is bounded**: past `maxEntries`, the least recently used
  answer goes.
- **Two identical queries at once share one** query to the resolver
  underneath. Each caller gets its own copy of the records.

`now` replaces the clock, so a spec can step through a TTL without
waiting:

```ts
let ms = 0;
const cached = cachedResolver(fixtureResolver({ 'example.com': { a: ['192.0.2.1'] } }), {
	now: () => ms,
});
await cached.a('example.com');
ms += 301_000; // past the fixture's TTL of 300 seconds: the next query asks again
```

## Answering the interface yourself

A resolver of your own implements `Resolver` and keeps its promises:

- it normalises names with `normalizeName`, and throws `INVALID_NAME`
  before any query;
- it answers with at least one record, or throws a `DnsError` with the
  codes above;
- it returns MX records sorted by priority, exchanges and PTR names
  lowercase with no trailing dot, and TXT strings joined.

`cachedResolver` works in front of it unchanged.
