# Troubleshooting

Each entry is headed by the message of the `DnsError` thrown; its `code`
is the group it is listed under. The parts shown as … vary.

**NOT_FOUND**

- [`DnsError: No … record (…)`](#dnserror-no--record-)
- [`DnsError: The fixture answers … with …`](#dnserror-the-fixture-answers--with-), when the fixture sets `NOT_FOUND`

**TEMPORARY**

- [`DnsError: The DNS could not answer … (…)`](#dnserror-the-dns-could-not-answer--)
- [`DnsError: The fixture answers … with …`](#dnserror-the-fixture-answers--with-)

**TIMEOUT**

- [`DnsError: The DNS did not answer … in time (…)`](#dnserror-the-dns-did-not-answer--in-time-)
- [`DnsError: The fixture answers … with …`](#dnserror-the-fixture-answers--with-), when the fixture sets `TIMEOUT`

**INVALID_NAME**

- [`DnsError: "…" is not a name to look up: …`](#dnserror--is-not-a-name-to-look-up-)
- [`DnsError: A name to look up is a string, not …`](#dnserror-a-name-to-look-up-is-a-string-not-)
- [`DnsError: "…" is not an IPv4 or IPv6 address to look up`](#dnserror--is-not-an-ipv4-or-ipv6-address-to-look-up)
- [`DnsError: The DNS refused the name in … (…)`](#dnserror-the-dns-refused-the-name-in--)

**INVALID_OPTION**

- [`DnsError: nodeResolver(): … must be an integer of at least …, not …`](#dnserror-noderesolver--must-be-an-integer-of-at-least--not-)
- [`DnsError: nodeResolver(): servers must be IP addresses, optionally with a port ('1.1.1.1', '[::1]:53'); …`](#dnserror-noderesolver-servers-must-be-ip-addresses-optionally-with-a-port-1111-153-)
- [`DnsError: nodeResolver(): … configure node:dns, so they cannot go with a backend; configure the backend itself`](#dnserror-noderesolver--configure-nodedns-so-they-cannot-go-with-a-backend-configure-the-backend-itself)
- [`DnsError: cachedResolver(): … must be an integer of at least …, not …`](#dnserror-cachedresolver--must-be-an-integer-of-at-least--not-)

## NOT_FOUND

### `DnsError: No … record (…)`

**When**: the DNS answered, and there is no such record: `No TXT
_dmarc.example.com record (ENOTFOUND)`. The parenthesis says how it was
learnt: `ENOTFOUND` or `ENODATA` from `node:dns`, `empty answer` when it
answered with no records, `the fixture has none` from a
`fixtureResolver`, or `the resolver underneath answered nothing` from a
`cachedResolver` whose inner resolver broke the contract with an empty
answer.

**Why**: the name does not exist, or it holds no record of that type.
Node's `node:dns` tells them apart (`ENOTFOUND`, `ENODATA`); Bun's
reports both as `ENOTFOUND`, so the error does not say which.

**Fix**: usually none: it is an answer. SPF and DMARC read it as `none`.
An SMTP client falls back from MX to A and AAAA (RFC 5321 §5.1). Check
the name you asked for: a DKIM key lives at
`<selector>._domainkey.<domain>`, a DMARC policy at `_dmarc.<domain>`.

```ts
import { DnsError, nodeResolver } from '@bumail/dns';

const dns = nodeResolver();
const domain = 'example.com';
try {
	await dns.txt(`_dmarc.${domain}`);
} catch (error) {
	if (error instanceof DnsError && error.code === 'NOT_FOUND') {
		// no DMARC policy: the result is none
	}
}
```

In a spec, add the record to the fixture: `fixtureResolver({
'_dmarc.example.com': { txt: ['v=DMARC1; p=none'] } })`.

## TEMPORARY

### `DnsError: The DNS could not answer … (…)`

**When**: `node:dns` failed with anything but "not found", "timed out" or
"bad name": `ESERVFAIL`, `EREFUSED`, `ECONNREFUSED`, `EBADRESP`, `EOF`…

**Why**: the DNS server is down, refused the query, or answered with
something unreadable. Nothing is known about the record.

**Fix**: treat it as a temporary failure: SPF's and DMARC's `temperror`,
and a deferred delivery for the SMTP client. `isTemporary(error)` is
true. If it lasts, check `servers` and that the machine can reach them on
port 53. A `cachedResolver` never keeps this error, so the next query
tries again.

```ts
import { isTemporary, nodeResolver } from '@bumail/dns';

try {
	await nodeResolver().mx('example.com');
} catch (error) {
	if (isTemporary(error)) {
		// SPF / DMARC: temperror. SMTP: answer 451 4.4.3 and let the sender retry.
	}
}
```

### `DnsError: The fixture answers … with …`

**When**: a `fixtureResolver` was given an error for that name or type:
`{ 'down.example': { error: 'TEMPORARY' } }` or `{ 'slow.example': { txt:
'TIMEOUT' } }`. The error carries that code: `TEMPORARY`, `TIMEOUT` or
`NOT_FOUND`.

**Why**: a spec asked for it, to check what the code under test does
when the DNS fails.

**Fix**: none, if that spec meant it. Otherwise give the name records
instead of an error.

## TIMEOUT

### `DnsError: The DNS did not answer … in time (…)`

**When**: `node:dns` gave `ETIMEOUT`. No server answered within `timeout`
milliseconds, `tries` times.

**Why**: the server is unreachable or slow, or a firewall drops DNS
traffic.

**Fix**: like `TEMPORARY`: a temporary failure, retried later.
`isTemporary(error)` is true. If it is frequent, raise `timeout` or
`tries`, or point `servers` at a resolver nearer the machine.

```ts
import { nodeResolver } from '@bumail/dns';

const dns = nodeResolver({ timeout: 5000, tries: 3 });
```

## INVALID_NAME

### `DnsError: "…" is not a name to look up: …`

**When**: a method was given a name that cannot be a host name. The end
of the message says why:

- `it holds a space or a control character`;
- `it is empty`, or `it has an empty label` (`a..b`, `.example`);
- `the label "…" is not 1 to 63 letters, digits, hyphens or underscores`
  (`*`, `/`, a leading or trailing hyphen, a label of 64 characters);
- `it is longer than 253 characters`;
- `it is an address; look its name up with ptr()`;
- `it holds "…", which no host name has`: URL syntax (`@`, `/`, `:`,
  `?`, `#`, `%`, `\`…), which the IDN mapping would read as syntax and
  so query another name (`évil@good.example` as `good.example`);
- `it holds an invisible character the IDN mapping would drop`: a soft
  hyphen, a zero-width joiner, any default-ignorable character;
- `its IDN mapping changes its labels`: a character the mapping turns
  into a dot (`。`, U+3002), so the name queried would not have the
  labels written;
- `its IDN mapping turns it into another name; write that name instead`:
  a compatibility character the mapping folds into a different one
  (fullwidth `ｅｘａｍｐｌｅ.com`, `ſtripe.com`, `ﬀ.com`, the Kelvin sign,
  `ⅹn--bcher-kva.com`), so the name queried would not be the one written.
  Only case and accent composition may change. It fails closed where
  JavaScript's lowercasing and the IDN mapping fold case in opposite
  directions: a Cherokee name is refused in either case, and so is a name
  whose last label is capital Greek ending in `Σ` (`x.ΣΑΣ`; write it in
  lowercase);
- `it is not a valid international name`.

**Why**: names are checked before any query, so text from a message (a
`MAIL FROM` domain, a DKIM `d=` tag, an SPF `include:`) cannot put
anything into one. Nothing was sent.

**Fix**: fix the name, or treat the error as the protocol says: SPF's
`permerror` for a malformed domain in a record, a `501` for a malformed
address in a command. To find the name an address points to, use `ptr()`:

```ts
import { nodeResolver } from '@bumail/dns';

const dns = nodeResolver();
await dns.ptr('192.0.2.1'); // not dns.a('192.0.2.1')
```

### `DnsError: A name to look up is a string, not …`

**When**: a method was given something other than a string: `undefined`,
a number, an object.

**Why**: usually a missing field: a domain read from a parse that
failed.

**Fix**: check the value before the lookup.

### `DnsError: "…" is not an IPv4 or IPv6 address to look up`

**When**: `ptr()` was given something other than an IPv4 or IPv6 address,
or an IPv6 address with a zone (`fe80::1%eth0`).

**Why**: `ptr()` takes the address itself (`192.0.2.1`, `2001:db8::1`),
not a name and not its `in-addr.arpa` form. A zone names a local
interface, which has no meaning in the DNS.

**Fix**: pass the address, without a zone; the resolver builds the
reverse name itself. An IPv4-mapped address (`::ffff:192.0.2.1`) is
accepted and looked up as its IPv4 address.

### `DnsError: The DNS refused the name in … (…)`

**When**: `node:dns` gave `EBADNAME` for a name that passed the check
here.

**Why**: `node:dns` applies its own rules on top. This should not
happen. If it does, the name passed `normalizeName` but `node:dns` still
refused it.

**Fix**: report it with the name, so the check here can catch it first.
Treat it as a malformed name meanwhile.

## INVALID_OPTION

### `DnsError: nodeResolver(): … must be an integer of at least …, not …`

**When**: `nodeResolver` was given an `assumedTtl` below 0, a `timeout`
or `tries` below 1, or one of them that is not a whole number.

**Why**: `assumedTtl` is the seconds a cache keeps MX, TXT and PTR
answers; `timeout` is milliseconds per try, and `tries` counts tries.

**Fix**: give whole numbers:

```ts
import { nodeResolver } from '@bumail/dns';

nodeResolver({ assumedTtl: 300, timeout: 3000, tries: 2 }); // assumedTtl: 0 lets a cache keep none
```

### `DnsError: nodeResolver(): servers must be IP addresses, optionally with a port ('1.1.1.1', '[::1]:53'); …`

**When**: `node:dns` refused one of `servers`; the end of the message is
its own reason.

**Why**: `node:dns` takes servers by address, not by name: it would need
a DNS to find them.

**Fix**: give addresses, with the port in the IPv6 form when it is not
53:

```ts
import { nodeResolver } from '@bumail/dns';

nodeResolver({ servers: ['1.1.1.1', '[2606:4700:4700::1111]:53'] });
```

### `DnsError: nodeResolver(): … configure node:dns, so they cannot go with a backend; configure the backend itself`

**When**: `nodeResolver` was given a `backend` and also `servers`,
`timeout` or `tries`; the message names which.

**Why**: those three configure the `node:dns` resolver that a `backend`
replaces, so they would do nothing.

**Fix**: drop them, and configure the backend you give:

```ts
import { Resolver } from 'node:dns/promises';
import { nodeResolver } from '@bumail/dns';

const backend = new Resolver({ timeout: 3000, tries: 2 });
backend.setServers(['1.1.1.1']);
const dns = nodeResolver({ backend });
```

### `DnsError: cachedResolver(): … must be an integer of at least …, not …`

**When**: `cachedResolver` was given a `maxEntries` below 1, or a
`maxTtl` or `negativeTtl` below 0, or a value that is not a whole number.

**Why**: `maxEntries` counts answers, and the TTLs are whole seconds.

**Fix**:

```ts
import { cachedResolver, nodeResolver } from '@bumail/dns';

cachedResolver(nodeResolver(), { maxEntries: 1000, maxTtl: 86_400, negativeTtl: 300 });
// negativeTtl: 0 keeps no NOT_FOUND at all
```
