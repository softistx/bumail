# @bumail/dns

The DNS answers a mail server needs (MX, TXT, A, AAAA and PTR) behind one
small interface, `Resolver`. Production asks `node:dns`, specs answer from
a fixture, and a cache in front of either honours the TTLs. Every failure
is a `DnsError` that tells "there is no such record" from "no answer was
had, try later": the difference SPF, DKIM and DMARC turn into `none` or
`temperror`. No dependency.

**Bun only**, like every `@bumail/*` package: it runs on Bun 1.4.2 or
later.

```sh
bun add @bumail/dns
```

## Usage

```ts
import { cachedResolver, nodeResolver } from '@bumail/dns';

const dns = cachedResolver(nodeResolver({ timeout: 3000, tries: 2 }));

await dns.mx('gmail.com'); // [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5, ttl: 300 }, …]
await dns.txt('gmail.com'); // [{ text: 'v=spf1 redirect=_spf.google.com', ttl: 300 }, …]
await dns.a('example.com'); // [{ address: '…', ttl: 98 }]
await dns.aaaa('example.com');
await dns.ptr('8.8.8.8'); // [{ name: 'dns.google', ttl: 300 }]
```

Every method answers with at least one record, or throws. Names are
normalised first: lowercase, no trailing dot, an IDN as its A-labels. A
name that cannot be a host name is refused with `INVALID_NAME` before
anything is sent. An MX answer comes sorted by priority, and a TXT
record's character-strings come joined into one `text`, as SPF (RFC 7208
§3.3) and DKIM read them.

## Errors

```ts
import { DnsError, isTemporary, nodeResolver } from '@bumail/dns';

const dns = nodeResolver();

try {
	await dns.txt('_dmarc.example.com');
} catch (error) {
	if (!(error instanceof DnsError)) throw error;
	error.code; // 'NOT_FOUND' | 'TEMPORARY' | 'TIMEOUT' | 'INVALID_NAME' | 'INVALID_OPTION'
	isTemporary(error); // true for TEMPORARY and TIMEOUT: DMARC's temperror, retry later
}
```

`NOT_FOUND` covers both "no such name" (NXDOMAIN) and "no record of that
type" (NODATA). Node's `node:dns` keeps them apart (`ENOTFOUND`,
`ENODATA`), but Bun's reports both as `ENOTFOUND`, so a resolver on Bun
cannot. Nothing bumail plans now needs the difference: SPF, DKIM, DMARC
(RFC 9091's `np=` included, whose non-existent domain is NXDOMAIN or
NODATA) and the SMTP client's MX fallback all take either.

## Specs: a fixture, never the network

```ts
import { fixtureResolver, isNullMx } from '@bumail/dns';

const dns = fixtureResolver({
	'example.com': {
		mx: [{ exchange: 'mx.example.com', priority: 10 }],
		txt: ['v=spf1 ip4:192.0.2.0/24 -all'],
	},
	'mx.example.com': { a: ['192.0.2.25'] },
	'nomail.example': { mx: [{ exchange: '.', priority: 0 }] }, // a null MX
	'down.example': { error: 'TEMPORARY' },
	'slow.example': { txt: 'TIMEOUT' },
});

isNullMx(await dns.mx('nomail.example')); // true: RFC 7505, the domain takes no mail
dns.queries; // [{ type: 'mx', name: 'nomail.example' }]: count lookups, as SPF's limit of ten needs
```

## Caching

```ts
import { cachedResolver, nodeResolver } from '@bumail/dns';

const dns = cachedResolver(nodeResolver(), {
	maxEntries: 1000, // the least recently used answer goes first
	maxTtl: 86_400, // no answer kept longer than a day, a NOT_FOUND included
	negativeTtl: 300, // NOT_FOUND kept 5 minutes (RFC 2308); TEMPORARY and TIMEOUT never
});
```

A cached answer comes back with the TTL it has left. Two identical queries
made at once share one query, and its answer or its error.

## Writing a zone file

`formatZone` is the other direction: the records you must publish, as
BIND zone-file lines, which Cloudflare, Route 53 and most DNS hosts
import as they are.

```ts
import { formatZone } from '@bumail/dns';

formatZone([
	{ name: 'example.com', type: 'MX', priority: 10, value: 'mail.example.com' },
	{ name: 'example.com', type: 'TXT', ttl: 3600, value: 'v=spf1 mx -all' },
	{ name: '_imaps._tcp.example.com', type: 'SRV', priority: 0, value: '1 993 mail.example.com' },
]);
// example.com. IN MX 10 mail.example.com.
// example.com. 3600 IN TXT "v=spf1 mx -all"
// _imaps._tcp.example.com. IN SRV 0 1 993 mail.example.com.
```

Names are absolute and get their trailing dot. A TXT value over 255 bytes
is split into several quoted strings, which a resolver joins back, with
quotes and backslashes escaped. It writes `A`, `AAAA`, `MX`, `TXT`,
`SRV`, `CAA`, `CNAME`, `NS` and `PTR`; anything it cannot hold is a
`DnsError`.

## Traps

- **MX, TXT and PTR carry an assumed TTL.** `node:dns` reports the TTL of
  A and AAAA records only, so `nodeResolver` gives the other three
  `assumedTtl` (300 seconds unless you set it), and a cache keeps them
  that long. An ANY query (RFC 8482) is no way around it.
- **A null MX is an answer, not an error.** `mx()` returns one record with
  an empty `exchange`, and `isNullMx` says so. A sender gives up on that
  domain at once, with no fallback to its A or AAAA records.
- **An address is not a name.** `mx('192.0.2.1')` is `INVALID_NAME`. Look
  an address up with `ptr()`.
- **A name is never swapped for another.** A name holding URL syntax
  (`@`, `/`, `:`, `?`, `#`, `%`, `\`), an invisible character the IDN
  mapping would drop (a soft hyphen, a zero-width joiner), or a character
  the mapping turns into another (`ｅｘａｍｐｌｅ.com`, `ſtripe.com`,
  `ⅹn--…`) is `INVALID_NAME`: only case and accent composition may change.
  So a name taken from a message, as SPF and DMARC take them, cannot make
  the resolver query a domain the sender chose.
- **`ptr()` folds an IPv4-mapped address.** `::ffff:192.0.2.1`, as a
  dual-stack listener reports an IPv4 peer, is looked up as `192.0.2.1`.
- **`servers`, `timeout` and `tries` configure `node:dns`.** Next to a
  `backend` they would be ignored, so `nodeResolver` refuses them there
  with `INVALID_OPTION`.

## API

| export | |
| --- | --- |
| `Resolver` | the interface: `mx`, `txt`, `a`, `aaaa`, `ptr`, each answering with records or throwing a `DnsError` |
| `MxRecord`, `TxtRecord`, `AddressRecord`, `PtrRecord`, `RecordType` | what a resolver answers: each record with its `ttl` in seconds |
| `nodeResolver(options?)`, `NodeResolverOptions`, `DnsBackend` | a `Resolver` on `node:dns/promises`: `servers`, `timeout`, `tries`, `assumedTtl`, and `backend` to query something else |
| `cachedResolver(resolver, options?)`, `CacheOptions` | a `Resolver` that keeps another's answers: `maxEntries`, `maxTtl`, `negativeTtl`, `now` |
| `fixtureResolver(records)`, `FixtureResolver`, `FixtureRecords`, `FixtureName`, `FixtureError` | a `Resolver` answering from a plain object, for specs; `queries` lists what it was asked |
| `DnsError`, `DnsErrorCode`, `isTemporary(error)` | `NOT_FOUND`, `TEMPORARY`, `TIMEOUT`, `INVALID_NAME`, `INVALID_OPTION`; whether retrying later could help |
| `isNullMx(records)` | whether an MX answer is a null MX (RFC 7505) |
| `formatZone(records)`, `ZoneRecord`, `ZoneRecordType` | records (`name`, `type`, `ttl?`, `value`, `priority?`) as BIND zone-file lines, names absolute, long TXT values split into strings of 255 bytes; `INVALID_NAME` or `INVALID_OPTION` for a record it cannot write |
| `normalizeName(name)` | a name as it is queried: lowercase, no trailing dot, A-labels; `INVALID_NAME` otherwise |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/dns/docs/README.md): the pages below, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/dns/docs/guide.md): the interface, `node:dns`, the fixture, writing a zone file, the cache, and what SPF, DKIM, DMARC and the SMTP client make of each answer.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/dns/docs/troubleshooting.md): every `DnsError`, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/dns/docs/roadmap.md): what is coming, and what is not planned.
