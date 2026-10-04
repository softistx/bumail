# @bumail/smtp

An SMTP server for Bun, on `Bun.listen`: RFC 5321 with PIPELINING, SIZE,
8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS or implicit TLS; AUTH
PLAIN and LOGIN, only once encrypted; hooks where your app accepts or
refuses a connection, a sender, a recipient or a message. It is never an
open relay. And, on `@bumail/smtp/client`, a client that delivers one
message to a smarthost, a submission server or a domain's MX hosts. No
dependency; `typescript` is an optional peer, for the types. MX delivery
needs a resolver: install `@bumail/dns` for one.

```sh
bun add @bumail/smtp
```

## An MX on port 25

Mail for your domains, from anyone. `onData` gets each message as a
stream while the client sends it. The client is told `250` only once
`onData` read `message.content` to its clean end and resolved without a
refusal; an `onData` that answers before the end, or cancels the stream,
gets the client `451 4.3.0`, and the message is not taken.

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/mx.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/mx.example.com.crt').text(),
	},
	async onData(message) {
		// message.envelope: { from, to, smtputf8, body }
		// message.content: a ReadableStream, this server's Received field on top.
		// Read it to its end: the 250 waits for it, and the read throws if
		// the message must not be delivered.
		const bytes = await new Response(message.content).bytes();
		await Bun.write(`spool/${message.id}.eml`, bytes);
	},
});

await server.listen({ port: 25 });
```

A recipient outside `localDomains` is refused with `554 5.7.1 Relay access
denied`. With `tls`, the server offers STARTTLS.

## Submission on 587, with STARTTLS and AUTH

Mail from your own users, to anywhere. `mode: 'submission'` refuses `MAIL`
until the session authenticated; AUTH is offered only after STARTTLS.

```ts
import { createSmtpServer } from '@bumail/smtp';

const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

const server = createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	async authenticate({ username, password }) {
		const hash = users.get(username);
		return hash !== undefined && (await Bun.password.verify(password, hash));
	},
	async onData(message, session) {
		const bytes = await new Response(message.content).bytes();
		console.log(`${session.user} sent ${message.id} (${bytes.length} bytes) to ${message.envelope.to.join(', ')}`);
	},
});

await server.listen({ port: 587 });
```

## Implicit TLS on 465

The same submission server, encrypted from the first byte (RFC 8314):
no STARTTLS, AUTH offered at once.

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	implicitTls: true,
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	authenticate: ({ username, password }) => username === 'alice' && password === Bun.env['ALICE_PASSWORD'],
	async onData(message) {
		const text = await new Response(message.content).text();
		console.log('received', message.id, text.length);
	},
});

await server.listen({ port: 465 });
```

A client has `handshakeTimeout` seconds (default 10) to complete its TLS
handshake, and holds a slot of `maxConnections` and
`maxConnectionsPerClient` meanwhile: a socket that never sends its
ClientHello is closed, without a word.

## Hooks for policy

A hook returns nothing to accept, or a `reply(code, status, text)` with a
4xx or 5xx code to refuse. A hook that throws, answers anything else, or
does not settle within `hookTimeout` refuses with `451 4.3.0`, a temporary
failure, so the sender tries again later; `onError` is told why.

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const blocked = new Set(['203.0.113.7']);
const mailboxes = new Set(['alice@example.com', 'postmaster@example.com']);

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onConnect: (session) =>
		blocked.has(session.remoteAddress) ? reply(554, '5.7.1', 'Go away') : undefined,
	onMailFrom: (path) =>
		path.domain === 'spam.example' ? reply(550, '5.7.1', 'Sender refused') : undefined,
	onRcptTo: (path) =>
		path.postmaster || mailboxes.has(path.address.toLowerCase())
			? undefined
			: reply(550, '5.1.1', 'No such user here'),
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
	onError: (error, session) => console.error(session.id, error),
});

await server.listen({ port: 25 });
```

The server's own checks run first: `onRcptTo` is never asked about a
recipient the server already refused, relaying included.

`RCPT TO:<postmaster>`, with no domain and in any case, is taken as the
server's own postmaster (RFC 5321 §4.5.1): it is not relaying, so it needs
no AUTH, and `localDomains` is not asked. `onRcptTo` gets a `Path` whose
`postmaster` is `true`, `address` and `local` `'postmaster'` and `domain`
`''`, and the envelope lists the recipient as `'postmaster'`, with no `@`.
Route it to a mailbox of your own:

```ts
import { createSmtpServer } from '@bumail/smtp';

const postmaster = 'postmaster@example.com';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const recipients = message.envelope.to.map((to) => (to === 'postmaster' ? postmaster : to));
		const bytes = await new Response(message.content).bytes();
		for (const to of recipients) await Bun.write(`spool/${to}/${message.id}.eml`, bytes);
	},
});
```

`<postmaster@domain>` is an ordinary path, checked as any other. The
[guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md#rcpt-topostmaster)
has the details.

## Limits

Every limit has a default; each must be a positive integer —
`greetingDelay` a number of seconds, `0` or more — or `createSmtpServer`
throws an `SmtpError` with code `INVALID_OPTION`.

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	maxMessageSize: 10 * 1024 * 1024, // bytes, announced as SIZE; default 25 MiB → 552 5.3.4
	maxRecipients: 50, // per message; default 100 → 452 4.5.3
	maxConnections: 200, // at once; default 1000 → 421 4.3.2
	maxConnectionsPerClient: 5, // at once from one IPv4 address or IPv6 /64; default 10 → 421 4.7.0
	handshakeTimeout: 10, // seconds to complete an implicit TLS handshake, or a proxy's PROXY header; default 10 → closed
	maxErrors: 5, // failed commands before hanging up; default 10 → 421 4.7.0
	timeout: 120, // idle seconds, from the client's last byte or the 220; default 300 → 421 4.4.2
	hookTimeout: 20, // seconds a hook has to settle; default 60 → 451 4.3.0
	greetingDelay: 5, // seconds before the 220; default 0 → 554 to a client that talks first
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});

const { port } = await server.listen({ port: 2525, hostname: '127.0.0.1' });
console.log(`listening on ${port}, ${server.connections} open`);
// later: server.stop(true) hangs up on every client too
```

## Behind a TCP proxy

Behind a TCP proxy such as a Traefik TCP router or HAProxy, every client
has the proxy's address. `proxyProtocol` reads the PROXY protocol,
versions 1 and 2, from the proxies it lists, so the server sees the
client's address again: in `session.remoteAddress`, every hook, the
Received field and `maxConnectionsPerClient`.

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	// The proxy's own address, or its network: never a range clients connect from.
	proxyProtocol: { trusted: ['10.0.0.5'] },
	onConnect: (session) => console.log('client', session.remoteAddress),
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
});

await server.listen({ port: 25 });
```

A listed peer must send its header first, within `handshakeTimeout`
(default 10 seconds), or it is reset without a word. A peer not listed is
served as without the option, and a header it sends is just bad input.
It works on 25 and 587 with STARTTLS, and on 465 with `implicitTls`. The
[guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md#running-behind-a-tcp-proxy)
has a Traefik configuration for all three.

## Send mail: to a smarthost, a submission server or Mailpit

`sendMail(message, options)` from `@bumail/smtp/client` delivers one
message to one host. The message is the whole RFC 5322 text — a string,
bytes, or a `ReadableStream` — with lines ending in CRLF.

```ts
import { sendMail } from '@bumail/smtp/client';

const message = [
	'From: Alice <alice@example.com>',
	'To: <bob@example.org>',
	'Subject: Hello',
	`Date: ${new Date().toUTCString()}`,
	'',
	'Hi Bob.',
	'',
].join('\r\n');

// Submission on 587: STARTTLS, the certificate checked, then AUTH.
const result = await sendMail(message, {
	host: 'smtp.example.com',
	port: 587,
	from: 'alice@example.com',
	to: ['bob@example.org'],
	auth: { username: 'alice', password: Bun.env['SMTP_PASSWORD'] ?? '' },
});
console.log(result.reply.code, result.accepted, result.rejected);

// Implicit TLS on 465.
await sendMail(message, { host: 'smtp.example.com', secure: true, from: 'alice@example.com', to: 'bob@example.org', auth: { username: 'alice', password: 'secret' } });

// Mailpit on 1025 (docker run -p 8025:8025 -p 1025:1025 axllent/mailpit): no TLS, no AUTH.
await sendMail(message, { host: 'localhost', port: 1025, from: 'alice@example.com', to: 'bob@example.org' });
```

It resolves once the server took the message for one recipient at least:
`accepted` and `rejected` give each recipient with the server's reply,
`reply` the reply to the final dot, and `tls` whether the session was
encrypted and the certificate checked. Anything else rejects with an
`SmtpError` whose `temporary` says whether trying later may succeed.

## Send mail: direct to a domain's MX

`{ domain, resolver }` instead of `{ host }` looks up the domain's MX
records through a `Resolver` from `@bumail/dns`, and tries its hosts by
preference (RFC 5321 §5.1), the domain's own address when it has none.
TLS is opportunistic: STARTTLS when offered, the certificate not checked.
`helo` is required: your server's public name, the one its address
resolves back to.

`@bumail/dns` must be installed for this — or pass any object with its
`mx`, `a` and `aaaa` methods:

```sh
bun add @bumail/smtp @bumail/dns
```

```ts
import { cachedResolver, nodeResolver } from '@bumail/dns';
import { SmtpError, sendMail } from '@bumail/smtp/client';

const resolver = cachedResolver(nodeResolver());
const message = [
	'From: Alice <alice@example.com>',
	'To: <bob@example.org>, <carol@example.org>',
	'Subject: Hello',
	`Date: ${new Date().toUTCString()}`,
	'',
	'Hi both.',
	'',
].join('\r\n');

try {
	const result = await sendMail(message, {
		domain: 'example.org',
		resolver,
		from: 'alice@example.com',
		to: ['bob@example.org', 'carol@example.org'],
		helo: 'mail.example.com',
	});
	console.log(`taken by ${result.host}`, result.tls);
	for (const { recipient, reply } of result.rejected) {
		console.log(recipient, reply.code >= 500 ? 'bounce' : 'try again later');
	}
} catch (error) {
	if (!(error instanceof SmtpError)) throw error;
	console.log(error.code, error.temporary ? 'try again later' : 'bounce', error.message);
}
```

A connection that fails, or a 4xx before MAIL FROM, moves on to the next
host; a 5xx stops. A null MX (RFC 7505) fails at once with `NULL_MX`.

## Security

- **Never an open relay.** A recipient outside `localDomains` is refused
  with `554 5.7.1 Relay access denied` unless the session authenticated —
  before any hook is asked, so no hook can open it. There is no option to
  relay without AUTH. Source routes and quoted local parts cannot smuggle a
  relay past the check.
- **AUTH only after TLS.** On a clear connection AUTH is not advertised, and
  `AUTH` is refused with `538 5.7.11` before the credentials are read. Three
  failed attempts and the server hangs up.
- **SMTP smuggling is refused.** Only the exact `<CRLF>.<CRLF>` ends a
  message. A message holding a bare LF or a bare CR is refused whole with
  `550 5.6.11 Bare CR or LF is not allowed in a message`, and its content
  stream ends in an `SmtpError` (`BARE_LINE_BREAK`), so `onData` never
  reads it to a clean end.
- **Commands pipelined after STARTTLS are dropped.** Whatever the client
  sent in clear behind `STARTTLS` is discarded, never run (CVE-2011-0411),
  and the session starts over: EHLO again, no transaction, no user.
- **A client that talks before the greeting is refused** with
  `554 <hostname> Talked before the greeting` and the connection closed
  (RFC 5321 §4.3.1); nothing it sent runs. `greetingDelay` holds the 220
  back for that many seconds once `onConnect` accepted, so a sender that
  does not wait gives itself away, as Postfix's postscreen does. A refusal
  from `onConnect` goes out at once, delay or not.
- **One client cannot take every slot.** `maxConnectionsPerClient`
  (default 10) bounds the connections one client holds at once, so a
  single host cannot fill `maxConnections`. A client is an IPv4 address,
  or an IPv6 address by its /64; an IPv4-mapped or NAT64 address counts as
  the IPv4 address inside it, so a dual-stack listener counts an IPv4
  client once. One more gets `421 4.7.0 <hostname> Too many connections
  from your address, try later` and is closed, before `onConnect`. Every
  close frees the slot: QUIT, a hang-up, an error, the idle time,
  `stop(true)`. Group addresses the same way in your own policy with
  `clientKey`:

  ```ts
  import { clientKey } from '@bumail/smtp';

  clientKey('::ffff:192.0.2.1'); // '192.0.2.1'
  clientKey('2001:db8::1'); // '2001:db8:0:0::/64': four groups, zeros written out
  ```
- **A TLS handshake is bounded.** On implicit TLS a socket is counted from
  the TCP connection on, before its handshake, and closed past
  `handshakeTimeout` (default 10 seconds) if the handshake has not
  completed; `onConnect` and the greeting come once it has. A STARTTLS
  handshake is bounded by `timeout`.
- **A PROXY header is trusted only from the peers `proxyProtocol` lists.**
  Any of them can claim any client address, so list the proxies' own
  addresses only, never a range clients connect from. From anyone else,
  the header never sets an address. A listed peer that sends no valid
  header within `handshakeTimeout` is reset, and holds no slot of
  `maxConnections` or `maxConnectionsPerClient` while it waits.
- **Bounded memory.** The server holds 64 KiB of a client's input and of a
  message at most, and stops reading the client past that; replies to a
  client that reads slowly wait in the server, and none is lost while the
  connection is open. A client that stops reading altogether is hung up on
  at its `timeout`, what it never read dropped, so it cannot hold a slot of
  `maxConnections`, on TLS too.

## Traps

**Client**

- **Opportunistic TLS does not check the certificate.** It is the default
  for MX delivery, as RFC 7435 has it: it beats a passive eavesdropper,
  not an active attacker. `result.tls.verified` says whether the
  certificate checked out anyway; pass `tls: 'required'` to refuse a host
  whose certificate does not. With `auth` or `secure`, `required` is the
  default.
- **`sendMail` is not a queue.** It tries one destination once — every MX
  host of it, in turn — and gives up. Retrying a `temporary` failure later,
  and bouncing a permanent one, is the caller's job until `@bumail/queue`.
- **Credentials go only to a checked certificate.** `auth` with `tls:
  'none'` or `'opportunistic'` is refused with `INVALID_OPTION` before
  connecting; leave `tls` out and it is `'required'`.
  `allowPlaintextAuth: true` lifts that, for a local test server only.
- **By MX, `helo` is required.** The machine's own name (`laptop.local`)
  is rarely one that resolves back to your address, which receiving hosts
  penalise; to a `{ host }` it stays the default.
- **A bare CR or LF in the message is refused** with `BARE_LINE_BREAK`, as
  a server must refuse it (SMTP smuggling). End every line with CRLF, or
  pass `normalizeLineEnds: true`.
- **One destination per call.** By MX, every recipient should be at
  `domain`; group them by domain first.

**Server**

- **Read `message.content` to its end before keeping anything.** An
  `onData` that answers before the end gets the client `451 4.3.0`, never
  `250`, and `onError` an `SmtpError` (`MESSAGE_NOT_READ`). The stream ends
  in an `SmtpError` when the message must not be delivered — too big,
  smuggled, the connection gone — and the client is then refused whatever
  `onData` answers. Something written before the stream ended may be a
  message the server refused: delete it when the read throws.
- **No read may outlive `onData`.** A read left running after `onData`
  answers ends in `MESSAGE_NOT_READ`, and one that starts after
  `hookTimeout` ends in `HOOK_TIMEOUT`: in both cases the client was told
  `451` and will send the message again, so keeping it would deliver it
  twice. Await the read inside `onData`.
- **An `onData` that read everything but answers after `hookTimeout`
  still gets the client `451`**, though its read ended cleanly. Only
  `message.signal` says so: it aborts whenever the server refuses the
  message on `onData`'s behalf — for example late, a throw, an answer that
  is not a refusal, the stream's own errors, or the connection closed
  before the reply; the guide's table lists every case. A refusal `onData`
  returns leaves it alone, unless the client never hears it: a later
  stream failure (whose 552 or 550 replaces `onData`'s reply) or a closed
  connection still aborts it, with that error. Check
  `if (message.signal.aborted) return;`
  just before keeping a message for good —
  [the guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md#when-the-refusal-comes-after-the-read)
  has the full example. RFC 5321 §6.1 tolerates a duplicate over a loss, so
  a race left open costs a second copy, never a lost message.
- `authenticate` needs `tls`, and so does `mode: 'submission'`:
  `createSmtpServer` throws without it.
- Ports 25, 465 and 587 are below 1024: binding them needs the privilege to,
  or a port forward from a higher one.
- A PLAIN authorization identity other than the username is refused with
  `535`: a session acts as the user it authenticated as.
- `Path.local` is kept as written: `<"v@x.example"@example.com>` and
  `<v%x.example@example.com>` are local parts of `example.com`. Never split
  an address on its first `@`.

## API

| export | |
| --- | --- |
| `createSmtpServer(options)` | the server; throws an `SmtpError` (`INVALID_OPTION`) on a bad option |
| `SmtpServer` | `listen({ port, hostname? })` (once; again throws `ALREADY_LISTENING`), `stop(closeConnections?)` (`true` hangs up on every client, after STARTTLS too), `connections` |
| `SmtpServerOptions` | `hostname`, `mode`, `localDomains`, `tls`, `implicitTls`, `authenticate`, the limits (`maxConnectionsPerClient` among them), `hookTimeout`, `handshakeTimeout`, `greetingDelay`, `proxyProtocol`, `onError`, and the hooks |
| `ProxyProtocolOptions` | `trusted`: the proxies' IPv4 and IPv6 addresses and CIDRs, the only peers whose PROXY header (v1 or v2) is read |
| `SmtpError`, `SmtpErrorCode` | `code`: `INVALID_OPTION`, `ALREADY_LISTENING`, and what a content stream or `onError` can get: `MESSAGE_TOO_BIG`, `BARE_LINE_BREAK`, `CONNECTION_LOST`, `HOOK_TIMEOUT`, `INVALID_HOOK_REPLY`, `MESSAGE_NOT_READ`; `sendMail`'s are listed below. `temporary`, `reply` and `rejected` are set for `sendMail`'s errors |
| `SmtpHooks` | `onConnect`, `onMailFrom`, `onRcptTo`, `onData` |
| `HookResult` | what a hook returns: `undefined` to accept, a `Reply` to refuse |
| `Session` | `id`, `remoteAddress`, `secure`, `helo`, `esmtp`, `user`, and `data` for your own state |
| `ReceivedMessage`, `Envelope` | what `onData` receives: `id`, `envelope` (`from`, `to`, `smtputf8`, `body`), `content`, a `ReadableStream<Uint8Array>`, and `signal`, an `AbortSignal` aborted when the server refuses the message on `onData`'s behalf — a refusal `onData` returns leaves it alone, unless a later stream failure replaces that reply or the connection closes before it is sent, which abort it instead |
| `TlsOptions` | `key` and `cert`, as `Bun.listen` takes them |
| `Credentials` | what `authenticate` receives: `mechanism`, `username`, `password`, `authorizationId?` |
| `reply(code, status, text)`, `Reply` | a reply, for a hook to refuse with |
| `formatReply(reply, enhanced?)` | a reply as sent on the wire, CRLF included |
| `parsePath(text, allowNull, sourceRoute?)`, `Path`, `SourceRoute` | `<local@domain>` (RFC 5321 §4.1.2) to `{ address, local, domain }` (and `postmaster: true` for `RCPT TO:<postmaster>`, which `parsePathCommand` gives); a source route `@a,@b:` is dropped (`'discard'`, the default) or refused (`'refuse'`); a control character (C0, DEL or C1), `>`, U+2028 or U+2029, Unicode format character (`\p{Cf}`) or lone surrogate anywhere, or an IPv4 literal octet above 255, refuses the path |
| `parseCommand(line)`, `Command` | a command line to `{ verb, argument }` |
| `parsePathCommand(argument, 'FROM' \| 'TO')`, `PathCommand` | the argument of MAIL or RCPT to `{ path, parameters }`; `TO:` also takes `<postmaster>` with no domain, in any case (RFC 5321 §4.1.1.3) |
| `clientKey(address)` | which client a remote address counts as, for a limit per client: an IPv4 address as it is, an IPv4-mapped or NAT64 address as its IPv4 address, any other IPv6 address as its /64, its first four groups written out, zeros included (`'2001:db8:1:2::/64'`, `'2001:db8:0:0::/64'` for `2001:db8::1`); `undefined` for what is not an IP address |
| `DataReader`, `DataChunk` | reads DATA: dot-unstuffing, the terminator, bare CR and LF counted |
| `decodePlain(response)`, `decodeLoginStep(response)` | SASL PLAIN (RFC 4616) and LOGIN responses to `Credentials` or text |

### `@bumail/smtp/client`

| export | |
| --- | --- |
| `sendMail(message, options)` | delivers one message; resolves to a `SendMailResult`, rejects with an `SmtpError` |
| `SendMailOptions` | `from`, `to`, and `{ host, port? }` or `{ domain, resolver, port? }`; `helo`, `tls`, `secure`, `ca`, `auth`, `allowPlaintextAuth`, `size`, `smtputf8`, `normalizeLineEnds`, `timeouts`, `deadline` |
| `HostDestination`, `MxDestination`, `SendMailEnvelope` | the parts of `SendMailOptions` |
| `SendMailResult` | `accepted`, `rejected`, `reply`, `host`, `port`, `tls` (`false` or `{ verified }`), `authenticated` |
| `SendMailAuth` | `username`, `password`, `mechanism?` (`PLAIN` or `LOGIN`) |
| `SendMailTimeouts` | seconds: `connect`, `greeting`, `command`, `mail`, `rcpt`, `dataStart`, `dataBlock`, `dataEnd` |
| `TlsMode` | `'opportunistic'`, `'required'` or `'none'` |
| `MessageSource` | `Uint8Array`, `string` or `ReadableStream<Uint8Array>` |
| `MxResolver` | what MX delivery asks of the DNS, by shape: `mx`, `a` and `aaaa`, as `@bumail/dns`'s `Resolver` has them |
| `isMailbox(address)` | whether `address` is exactly one `sendMail` takes (it checks with the same predicate): an RFC 5321 Mailbox, `local@domain` (§4.1.2, no brackets), with no source route, no control character (C0, DEL or C1), no `>`, no U+2028 or U+2029, no Unicode format character (`\p{Cf}`), no lone surrogate and no IPv4 literal octet above 255; check addresses you keep for later when you take them |
| `resolveMx(domain, resolver)`, `MailHost` | a domain's mail hosts in the order to try them: `{ host, priority, implicit }`; `NULL_MX` or `DNS_FAILED` otherwise |
| `SmtpError`, `SmtpErrorCode`, `SmtpErrorDetails`, `RecipientReply`, `Reply` | as above; `sendMail` adds the codes `CONNECTION_FAILED`, `CONNECTION_LOST`, `TIMEOUT`, `BAD_REPLY`, `REFUSED`, `RECIPIENTS_REFUSED`, `TLS_UNAVAILABLE`, `TLS_FAILED`, `AUTH_UNAVAILABLE`, `EXTENSION_MISSING`, `MESSAGE_TOO_BIG`, `BARE_LINE_BREAK`, `NULL_MX`, `DNS_FAILED`, `INVALID_OPTION` |

## Documentation

These pages ship in the package, under `docs/`.

- [Index](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md): the session and every reply, hooks and their order, `Session.data`, what `onData` receives, TLS, running behind a TCP proxy, sending mail with the client and trying it with Mailpit, the RFCs implemented and what is not.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/troubleshooting.md): every error, the replies a client reports, and every error `sendMail` rejects with.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/roadmap.md): what is coming, and what is not planned.
