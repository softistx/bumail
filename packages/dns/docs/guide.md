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
import { isNullMx, nodeResolver } from '@bumail/dns';

const dns = nodeResolver();
const records = await dns.mx('example.com');
if (isNullMx(records)) {
	// the domain says it takes no mail: bounce at once, no A/AAAA fallback
}
```

`isNullMx` is true for that single record only. A broken zone that lists
`0 .` next to real MX records gives an answer holding an empty `exchange`
among real ones: an SMTP client skips the empty one and tries the others.

TXT records are long strings cut into character-strings of 255 bytes at
most. `txt()` joins each record's pieces with nothing between them, as
SPF (RFC 7208 §3.3) and DKIM (RFC 6376 §3.6.2.2) require. Several records
stay several:

```ts
import { nodeResolver } from '@bumail/dns';

const dns = nodeResolver();
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
expected.

The IDN mapping goes through the URL API, which would read URL syntax
and drop what it does not show. So, before it, a name holding `@`, `/`,
`:`, `?`, `#`, `%` or `\` is refused, and so is one holding an invisible
character the mapping would drop (a soft hyphen, a zero-width joiner); a
mapping that would add a dot (`。`, U+3002) is refused too. Without that,
`évil@good.example` would be queried as `good.example`.

After it, the A-labels must read back as the name written, lowercased and
in NFC: UTS #46 folds compatibility characters, so fullwidth
`ｅｘａｍｐｌｅ.com`, mathematical `𝐠𝐨𝐨𝐠𝐥𝐞.com`, `ſtripe.com`, `ﬀ.com`, the
Kelvin sign and even `ⅹn--bcher-kva.com` would otherwise become plain
`example.com`, `google.com`… or an A-label the sender picked. Those are
refused. Case, composed accents and `ß` pass: the mapping is
nontransitional, so `straße.de` is `xn--strae-oqa.de`, not `strasse.de`.
A name taken from a message (a `MAIL FROM` domain, a DKIM `d=` tag) is
therefore queried as written, or not at all:

```ts
import { DnsError, normalizeName } from '@bumail/dns';

try {
	normalizeName('évil@good.example');
} catch (error) {
	if (error instanceof DnsError) error.message; // '"évil@good.example" is not a name to look up: it holds "@", which no host name has'
}
```

`ptr()` takes an IPv4 or IPv6 address instead, and refuses anything else
the same way, a zone (`fe80::1%eth0`) included. An IPv6 address is
queried in its canonical form (`2001:0DB8:0:0::1` → `2001:db8::1`), so
one address is one cache entry and one fixture key. An IPv4-mapped address
(`::ffff:192.0.2.1`, how a dual-stack `Bun.listen` reports an IPv4 peer)
is folded to `192.0.2.1`, so its PTR is looked up in `in-addr.arpa`,
where it lives.

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
import { DnsError, isTemporary, nodeResolver } from '@bumail/dns';

const dns = nodeResolver();

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

`NOT_FOUND` does not say whether the name exists. Node's `node:dns`
keeps NXDOMAIN and NODATA apart (`ENOTFOUND`, `ENODATA`), but Bun's
reports both as `ENOTFOUND`, so no resolver on Bun can tell them apart.
Nothing bumail plans now needs the difference: SPF counts both as a void
lookup (RFC 7208 §4.6.4), DMARC reads both as "no policy", RFC 9091's
`np=` defines a non-existent domain as NXDOMAIN *or* NODATA, and the SMTP
client's fallback from MX to A gives the same result either way, because
the A query then fails too for a name that does not exist.

## On node:dns

```ts
import { nodeResolver } from '@bumail/dns';

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

The options are checked when the resolver is built, and a bad one is
`INVALID_OPTION`: a `timeout` or `tries` that is not a whole number of at
least 1, an `assumedTtl` below 0, and a server `node:dns` cannot take
(`'not-an-ip'`).

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
import { type DnsBackend, nodeResolver } from '@bumail/dns';

const backend: DnsBackend = {
	resolve4: async () => [{ address: '192.0.2.1', ttl: 60 }],
	resolve6: async () => [],
	resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }],
	resolveTxt: async () => [['v=spf1 -all']],
	reverse: async () => ['mail.example.com'],
};
const fake = nodeResolver({ backend });
```

`servers`, `timeout` and `tries` configure `node:dns`, so next to a
`backend` they would do nothing: `nodeResolver` refuses them there with
`INVALID_OPTION`. Configure the backend itself instead.

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
import { fixtureResolver } from '@bumail/dns';

const dns = fixtureResolver({ 'example.com': { txt: ['v=spf1 -all'] } });
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
- **`NOT_FOUND`** is kept for `negativeTtl` (RFC 2308), and never longer
  than `maxTtl`. The SOA minimum that should bound it is not something
  `node:dns` returns, so it is this fixed time; 0 keeps none.
- **An empty answer** from the resolver underneath breaks the `Resolver`
  contract; the cache turns it into `NOT_FOUND` and never keeps it as an
  answer.
- **`TEMPORARY` and `TIMEOUT` are never kept.** The next query asks again,
  so a server that was down for a second is not remembered as down for
  five minutes.
- **Memory is bounded**: past `maxEntries`, the least recently used
  answer goes.
- **Two identical queries at once share one** query to the resolver
  underneath, its answer or its error. Each caller gets its own copy of
  the records.

`now` replaces the clock, so a spec can step through a TTL without
waiting:

```ts
import { cachedResolver, fixtureResolver } from '@bumail/dns';

let ms = 0;
const cached = cachedResolver(fixtureResolver({ 'example.com': { a: ['192.0.2.1'] } }), {
	now: () => ms,
});
await cached.a('example.com');
ms += 301_000; // past the fixture's TTL of 300 seconds: the next query asks again
```

## Writing a zone file

A resolver reads the DNS; `formatZone` writes what to put in it. It takes
`ZoneRecord`s and gives BIND zone-file text, one line per record, ending
in a newline. The line is `name [ttl] IN TYPE data`.

```ts
import { formatZone } from '@bumail/dns';

const zone = formatZone([
	{ name: 'mail.example.com', type: 'A', ttl: 3600, value: '192.0.2.10' },
	{ name: 'example.com', type: 'MX', priority: 10, value: 'mail.example.com' },
	{ name: 'example.com', type: 'CAA', value: '0 issue letsencrypt.org' },
]);
// mail.example.com. 3600 IN A 192.0.2.10
// example.com. IN MX 10 mail.example.com.
// example.com. IN CAA 0 issue "letsencrypt.org"
```

What each `value` holds:

| type | `value` | `priority` |
| --- | --- | --- |
| `A`, `AAAA` | the address | not allowed |
| `MX` | the host name; `.` for a null MX (RFC 7505) | the preference, required |
| `CNAME`, `NS`, `PTR` | the host name | not allowed |
| `SRV` | `<weight> <port> <target>`, such as `1 993 mail.example.com` | the priority, required |
| `CAA` | `<flags> <tag> <value>`, such as `0 issue letsencrypt.org` | not allowed |
| `TXT` | the text, unescaped, of any length | not allowed |

**Names are always absolute.** `example.com` is written `example.com.`; a
name is lowercased, an IDN is written in its A-labels (`normalizeName`'s
rules), and one that is not a host name is `INVALID_NAME`. There is no
`@` and no origin. A host name in a value (an MX's exchange, an SRV's
target) is written the same way.

**A TXT value is split for you.** One character-string is 255 bytes at
most (RFC 1035 §3.3), and a 2048-bit DKIM key is longer, so the value
comes out as several quoted strings, cut at 255 UTF-8 bytes and never in
the middle of a character. A resolver joins them back: what `txt()`
answers is the value you gave. `"` and `\` are escaped, and a control
character is written `\DDD`.

```ts
formatZone([{ name: 'k._domainkey.example.com', type: 'TXT', value: `v=DKIM1; k=rsa; p=${'A'.repeat(400)}` }]);
// k._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=AAAA…" "AAAA…"
```

A record it cannot write throws a `DnsError` naming it by its index:
`INVALID_NAME` for a name, `INVALID_OPTION` for the rest. Nothing is
written for the records before it.

## Answering the interface yourself

A resolver of your own implements `Resolver` and keeps its promises:

- it normalises names with `normalizeName`, and throws `INVALID_NAME`
  before any query;
- it answers with at least one record, or throws a `DnsError` with the
  codes above;
- it returns MX records sorted by priority, exchanges and PTR names
  lowercase with no trailing dot, and TXT strings joined.

`cachedResolver` works in front of it unchanged.
