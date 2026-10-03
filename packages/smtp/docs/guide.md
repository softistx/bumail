# Guide

How to run `@bumail/smtp` and what it does on the wire: the session and its
replies, the hooks, what a delivered message looks like, TLS, sending mail
with the client, and the RFCs behind each behaviour.

- [The smallest server](#the-smallest-server)
- [Options](#options)
- [The session, and what each reply means](#the-session-and-what-each-reply-means)
- [Hooks, and their order](#hooks-and-their-order)
- [Session.data](#sessiondata)
- [What onData receives](#what-ondata-receives)
- [Delivering into @bumail/store](#delivering-into-bumailstore)
- [Authentication](#authentication)
- [TLS](#tls)
- [Limits](#limits)
- [Sending mail: the client](#sending-mail-the-client)
- [Protocol helpers](#protocol-helpers)
- [The RFCs implemented](#the-rfcs-implemented)
- [What is not implemented](#what-is-not-implemented)

## The smallest server

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const text = await new Response(message.content).text();
		console.log(message.envelope.from, '→', message.envelope.to, text.length);
	},
});

const { port } = await server.listen({ port: 2525, hostname: '127.0.0.1' });
console.log(`listening on ${port}`);
```

`onData` is the only hook you must give: it is where a message goes, as a
stream, while the client sends it. `listen` resolves once the port is bound; `port: 0` picks a free
one, and the returned `port` says which.

```ts
export function createSmtpServer(options: SmtpServerOptions): SmtpServer;

export interface SmtpServer {
	/** Starts listening; resolves once the port is bound. Default hostname '0.0.0.0'. Once only. */
	listen(options: { port: number; hostname?: string }): Promise<{ port: number; hostname: string }>;
	/** Stops listening; `closeConnections` hangs up on every client too. */
	stop(closeConnections?: boolean): void;
	/** Open connections. */
	readonly connections: number;
}
```

## Options

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `hostname` | `string` | required, no default | the server's name, in its greeting, its EHLO reply and its Received fields; letters, digits, dots and hyphens |
| `localDomains` | `string[]` or `(domain) => boolean \| Promise<boolean>` | required | the domains it receives mail for; any other recipient is relaying, refused without AUTH |
| `mode` | `'mx' \| 'submission'` | `'mx'` | `mx` takes mail for `localDomains` from anyone; `submission` takes mail only from authenticated users (RFC 6409) |
| `tls` | `{ key, cert }` | none | turns on STARTTLS, or implicit TLS with `implicitTls` |
| `implicitTls` | `boolean` | `false` | TLS from the first byte (RFC 8314, port 465); needs `tls` |
| `authenticate` | `(credentials, session) => boolean \| Promise<boolean>` | none | turns on AUTH PLAIN and LOGIN, over TLS only, so it needs `tls`; required by `submission` |
| `maxMessageSize` | `number` | 25 MiB | bytes; announced with SIZE |
| `maxRecipients` | `number` | `100` | recipients per message |
| `maxConnections` | `number` | `1000` | open connections at once |
| `maxErrors` | `number` | `10` | failed commands before the server hangs up |
| `timeout` | `number` | `300` | seconds since the client's last byte, or since the 220, before the server hangs up |
| `hookTimeout` | `number` | `60` | seconds a hook, `authenticate` or `localDomains` has to settle, and `onData` to read on; past it, `451 4.3.0`. At most 2 147 483, what a timer can wait |
| `greetingDelay` | `number` | `0` | seconds the server waits, once `onConnect` accepted, before its 220; a client that talks meanwhile gets `554` and is hung up on. Fractions are allowed |
| `onConnect`, `onMailFrom`, `onRcptTo` | hooks | none | see [Hooks](#hooks-and-their-order) |
| `onData` | hook | required | receives each message, as a stream |
| `onError` | `(error, session) => void` | none | told of what went wrong in your code: a hook, `authenticate` or `localDomains` that threw or timed out, a hook reply that is not a refusal |

`localDomains` is matched against the whole domain, without case:
`example.com` takes `b@EXAMPLE.COM`, not `b@sub.example.com` nor
`b@evilexample.com`. A function decides for itself, and is given the domain
in lower case; if it throws or does not settle within `hookTimeout`, that
recipient gets `451 4.3.0` — never taken as local:

```ts
import { createSmtpServer } from '@bumail/smtp';

const hosted = new Set(['example.com', 'example.org']);

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: async (domain) => hosted.has(domain) || domain.endsWith('.example.com'),
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});

await server.listen({ port: 25 });
```

`createSmtpServer` checks its options once and throws an `SmtpError` with
`code: 'INVALID_OPTION'` for:

| Message | Cause |
| --- | --- |
| `createSmtpServer(): "<hostname>" is not a host name` | `hostname` is missing (`"undefined" is not a host name`), or has a character other than a letter, a digit, `.` or `-` |
| `createSmtpServer(): onData must be a function: it is where messages go` | no `onData` |
| `createSmtpServer(): implicitTls needs tls: { key, cert }` | `implicitTls: true` without `tls` |
| `createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate` | `mode: 'submission'` without `authenticate` |
| `createSmtpServer(): authenticate needs tls: { key, cert }, since AUTH is offered only once encrypted` | `authenticate` without `tls` |
| `createSmtpServer(): localDomains must be an array of domains or a function` | `localDomains` missing, a string, or an array holding something else |
| `createSmtpServer(): <limit> must be a positive integer, not <value>` | a limit or `hookTimeout` that is `0`, negative, fractional or `NaN` |
| `createSmtpServer(): hookTimeout must be at most 2147483 seconds, not <value>` | `hookTimeout` past what `setTimeout` can wait (about 24.8 days) |
| `createSmtpServer(): greetingDelay must be a number of seconds, 0 or more, not <value>` | `greetingDelay` negative, `NaN` or `Infinity` |
| `createSmtpServer(): greetingDelay (<n> s) must be shorter than timeout (<n> s), or every client times out before the greeting` | `greetingDelay` as long as `timeout`, or longer |

`listen` a second time throws an `SmtpError` with `code:
'ALREADY_LISTENING'`: create another server for another port.

What to do about each is in [Troubleshooting](troubleshooting.md).

## The session, and what each reply means

A session as RFC 5321 Appendix D.1 prints it, with an `onRcptTo` that
refuses `Green`:

```
S: 220 foo.com ESMTP ready
C: EHLO bar.com
S: 250-foo.com greets bar.com
S: 250-PIPELINING
S: 250-SIZE 26214400
S: 250-8BITMIME
S: 250-SMTPUTF8
S: 250 ENHANCEDSTATUSCODES
C: MAIL FROM:<Smith@bar.com>
S: 250 2.1.0 OK
C: RCPT TO:<Jones@foo.com>
S: 250 2.1.5 OK
C: RCPT TO:<Green@foo.com>
S: 550 5.1.1 No such user here
C: RCPT TO:<Brown@foo.com>
S: 250 2.1.5 OK
C: DATA
S: 354 End data with <CR><LF>.<CR><LF>
C: Blah blah blah...
C: ...etc. etc. etc.
C: .
S: 250 2.0.0 OK queued as 3f9c0a1b2c3d4e5f6a7b
C: QUIT
S: 221 2.0.0 foo.com closing connection
```

The EHLO reply adds `STARTTLS` when `tls` is set and the connection is
clear, and `AUTH PLAIN LOGIN` when `authenticate` is set, the connection is
encrypted, and the session has not authenticated yet.

Enhanced status codes (`2.1.0`, RFC 3463) are written only after EHLO; a
client that said HELO gets `250 OK`. Replies come in the order the commands
were sent, even when a client pipelines a whole transaction in one write.

Every reply the server sends of its own:

| Reply | When |
| --- | --- |
| `220 <hostname> ESMTP ready` | the greeting |
| `250 <hostname> greets <name>` | EHLO or HELO accepted; either one also ends a transaction in progress |
| `501 Syntax: EHLO hostname` / `501 Syntax: HELO hostname` | the EHLO or HELO argument is missing, or is not a domain or an address literal; no enhanced code before an EHLO was accepted, `501 5.5.4 Syntax: EHLO hostname` after one |
| `250 2.1.0 OK` | MAIL FROM accepted |
| `250 2.1.5 OK` | RCPT TO accepted |
| `354 End data with <CR><LF>.<CR><LF>` | DATA: send the message |
| `250 2.0.0 OK queued as <id>` | the message was taken: `onData` read its content stream to the clean end and resolved without refusing |
| `250 2.0.0 OK` | RSET (the transaction is forgotten) or NOOP |
| `252 2.5.0 Cannot VRFY user; send the message and it will be tried` | VRFY: no account is confirmed nor denied (RFC 5321 §3.5.3) |
| `214 2.0.0 See RFC 5321` | HELP |
| `221 2.0.0 <hostname> closing connection` | QUIT |
| `503 Send EHLO first` | MAIL or AUTH before EHLO (or after STARTTLS); no enhanced code, since no EHLO is in effect |
| `503 5.5.1 Nested MAIL command` | a second MAIL in one transaction |
| `503 5.5.1 Send MAIL first` | RCPT or DATA before MAIL |
| `554 5.5.1 No valid recipients` | DATA with no recipient accepted; what the client pipelined behind it in the same write is dropped, not run as commands |
| `501 5.5.4 Syntax: MAIL FROM:<address>` / `RCPT TO:<address>` / `DATA` | the command's syntax is wrong |
| `555 5.5.4 <PARAM> is not supported` | an ESMTP parameter other than SIZE, BODY, SMTPUTF8 and AUTH on MAIL, or any parameter on RCPT |
| `555 5.5.4 <PARAM> needs EHLO` | a parameter after HELO |
| `501 5.5.4 Syntax: SIZE=<bytes>` | SIZE is not a number |
| `501 5.5.4 BODY is 7BIT or 8BITMIME` | another BODY value |
| `553 5.6.7 A non-ASCII address needs SMTPUTF8` | a UTF-8 address in a transaction that did not ask for SMTPUTF8 |
| `530 5.7.0 Authentication required` | MAIL on a `submission` server before AUTH |
| `554 5.7.1 Relay access denied` | a recipient outside `localDomains`, and the session did not authenticate |
| `452 4.5.3 Too many recipients` | past `maxRecipients`; the recipients already taken stand |
| `552 5.3.4 Message too big for system` | SIZE= over `maxMessageSize` at MAIL, or a message over it after DATA |
| `550 5.6.11 Bare CR or LF is not allowed in a message` | the message holds a CR or LF that is not part of a CRLF |
| `451 4.3.0 Local error in processing` | a hook threw, timed out or answered a reply under 400; `localDomains` threw or timed out; `onData` stopped reading the message, or answered without reading it to its end |
| `554 <hostname> Talked before the greeting` | the client sent something before the 220 — during `onConnect` or `greetingDelay` (RFC 5321 §4.3.1); the server hangs up |
| `500 5.5.2 Command unrecognized` | an unknown verb — EXPN, BDAT and the rest |
| `500 5.5.6 Line too long` | a command line over 2048 bytes; the rest of it is skipped |
| `421 4.3.2 <hostname> Too many connections, try later` | a connection past `maxConnections`, then the server hangs up |
| `421 4.4.2 <hostname> Idle too long, closing` | nothing for `timeout` seconds |
| `421 4.7.0 <hostname> Too many errors, closing` | `maxErrors` failed commands |
| `421 4.3.0 Local error, closing` | the server failed itself |

STARTTLS and AUTH have replies of their own, under [TLS](#tls) and
[Authentication](#authentication).

Every command the server refuses of its own counts towards `maxErrors` —
syntax, order, a parameter, relaying, an unknown verb, a failed AUTH —
except `452 4.5.3`, `451 4.3.0`, `454 4.7.0 Temporary authentication
failure`, and the refusals at the end of DATA (`552 5.3.4`, `550 5.6.11`).
A refusal from your own hook never counts.

## Hooks, and their order

```ts
export type HookResult = Reply | undefined | void;

export interface SmtpHooks {
	onConnect?(session: Session): HookResult | Promise<HookResult>;
	onMailFrom?(path: Path, session: Session): HookResult | Promise<HookResult>;
	onRcptTo?(path: Path, session: Session): HookResult | Promise<HookResult>;
	onData(message: ReceivedMessage, session: Session): HookResult | Promise<HookResult>;
}
```

A hook accepts by returning nothing, and refuses by returning a `Reply` —
build one with `reply(code, status, text)`, a 4xx code for "try again
later", a 5xx for "no". The reply is sent as given.

```ts
import { reply } from '@bumail/smtp';

reply(550, '5.1.1', 'No such user here'); // 550 5.1.1 No such user here
reply(450, '4.2.0', 'Mailbox busy, try later'); // a temporary refusal
```

In the order a session meets them:

| Hook | Runs | After the server checked | A refusal |
| --- | --- | --- | --- |
| `onConnect` | when a client connects, before the greeting | the connection count | replaces the greeting, at once even with `greetingDelay`; then the server hangs up. When `onConnect` accepts, a client that talked before the greeting is refused with `554` |
| `authenticate` | at AUTH | TLS, EHLO, no transaction in progress | see [Authentication](#authentication) |
| `onMailFrom` | at each MAIL FROM | EHLO, AUTH in `submission`, syntax, parameters, SIZE, SMTPUTF8 | refuses the sender; the client may try another MAIL |
| `onRcptTo` | at each RCPT TO | MAIL, syntax, SMTPUTF8, `maxRecipients`, **relaying** | refuses that recipient; the others stand |
| `onData` | at DATA, with the message as a stream, while the client sends it | a recipient was accepted | refuses the message, once it ended; the next transaction starts clean |

A hook is never asked about what the server already refused: `onRcptTo`
never sees a recipient refused for relaying, so no hook can open the relay.

Hooks run one at a time, in the order of the commands. A client that
pipelines gets every reply in order: a slow `onMailFrom` holds the replies to
the commands behind it.

A hook that throws, whose promise rejects, that does not settle within
`hookTimeout` seconds, or that answers a reply under 400 refuses with
`451 4.3.0 Local error in processing` — a temporary failure, so the sender
keeps the message and tries again. A reply under 400 is not a refusal:
sending it would tell the client yes while the server did not take the
command. Each of these goes to `onError`, with an `SmtpError` of code
`HOOK_TIMEOUT` or `INVALID_HOOK_REPLY`, or the error your hook threw; an
`onData` that answers without reading the message to its end, with
`MESSAGE_NOT_READ`. Let `onData` throw when the message could not be
stored:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const known = new Set(['alice@example.com', 'bob@example.com']);

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onRcptTo: (path) =>
		known.has(`${path.local.toLowerCase()}@${path.domain}`)
			? undefined
			: reply(550, '5.1.1', 'No such user here'),
	async onData(message) {
		if (message.envelope.from === '') console.log('a bounce');
		const bytes = await new Response(message.content).bytes();
		await Bun.write(`spool/${message.id}.eml`, bytes); // a throw here: 451 4.3.0
	},
	onError: (error, session) => console.error(`[${session.id}]`, error),
});

await server.listen({ port: 25 });
```

`onMailFrom` and `onRcptTo` receive the `Path` the client gave:

```ts
export interface Path {
	/** `local@domain`; `''` for the null reverse-path `<>`: a bounce. */
	readonly address: string;
	/** As sent: case is kept. */
	readonly local: string;
	/** Lower case. */
	readonly domain: string;
}
```

A source route (`<@a.example:b@c.example>`, RFC 5321 Appendix C) is dropped:
the path is `b@c.example`. It is taken only as `@domain(,@domain)*:`, each
hop a valid domain or address literal; any other route — an empty hop, a
hop without its `@`, a hop that is not a domain — is a `501 5.5.4 Syntax`.

`local` is kept as written, quotes included. `<"v@x.example"@example.com>`
and `<v%x.example@example.com>` are local parts of `example.com`, and
passed the relay check as such: code that delivers must take the domain
after the last `@` — `path.domain` — and never split `address` on its
first `@`. C0 controls (CR, LF, NUL, tab…), DEL and `>`, C1 controls,
Unicode format characters (zero-width, bidi, BOM), U+2028/2029 and lone
surrogates are refused anywhere in a path — the route, the local part
quoted or not, the domain — even under SMTPUTF8. An IPv4 address literal
takes octets up to 255: `[999.1.1.1]` is not one.

## Session.data

Every hook, and `authenticate`, receives the `Session`:

```ts
export interface Session {
	readonly id: string;
	readonly remoteAddress: string;
	/** TLS is on: implicit, or after STARTTLS. */
	readonly secure: boolean;
	/** The name the client gave in EHLO or HELO. */
	readonly helo?: string;
	/** The client said EHLO, not HELO. */
	readonly esmtp: boolean;
	/** The username the client authenticated as. */
	readonly user?: string;
	/** For the app's own state across hooks. */
	readonly data: Record<string, unknown>;
}
```

The `Session` a hook receives is a snapshot of that moment: read
`session.user` in the hook, not from an object kept since `onConnect`.
`data` is the one object that is shared: the same record for every hook of
the connection, for you to keep what one hook learnt for the next. It lasts
as long as the connection — across transactions, RSET and STARTTLS — and
the server never reads it. STARTTLS makes the server forget what it learnt
in clear (RFC 3207 §4.2), but not `data`: what you keep there, and whether
it still holds once encrypted, is yours to judge.

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onConnect(session) {
		const listed = await isListed(session.remoteAddress);
		session.data['listed'] = listed;
	},
	onRcptTo(path, session) {
		if (session.data['listed'] === true && path.local !== 'postmaster') {
			return reply(554, '5.7.1', `${session.remoteAddress} is listed`);
		}
		return undefined;
	},
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
});

await server.listen({ port: 25 });

async function isListed(address: string): Promise<boolean> {
	return address.startsWith('203.0.113.');
}
```

Values come out as `unknown`; narrow them where you read them. Under
`noPropertyAccessFromIndexSignature`, write `session.data['listed']`.

## What onData receives

```ts
export interface ReceivedMessage {
	/** The id the server gave it, also in its Received field and the 250 reply. */
	readonly id: string;
	readonly envelope: Envelope;
	/**
	 * The message as it arrives, dot-unstuffed, with the server's Received
	 * field first. It errors with an `SmtpError` when the message must not be
	 * delivered.
	 */
	readonly content: ReadableStream<Uint8Array>;
	/**
	 * Aborts when the server refuses the message on `onData`'s behalf; its
	 * `reason` says why. A refusal `onData` returns leaves it alone, unless
	 * the client never hears it: a later stream failure (whose 552 or 550
	 * replaces `onData`'s reply) or a closed connection still aborts it,
	 * with that error.
	 */
	readonly signal: AbortSignal;
}

export interface Envelope {
	/** `''` for the null reverse-path `<>`: a bounce. */
	readonly from: string;
	readonly to: readonly string[];
	/** The client asked for SMTPUTF8 (RFC 6531). */
	readonly smtputf8: boolean;
	/** `7BIT` or `8BITMIME`, as MAIL FROM's BODY= said; `7BIT` when it said nothing. */
	readonly body: '7BIT' | '8BITMIME';
}
```

The **envelope** is what MAIL FROM and RCPT TO said — not the `From:` and
`To:` of the message, which may differ (Bcc, mailing lists, forwarding).
`to` holds only the recipients the server and `onRcptTo` accepted. Deliver
to the envelope.

The **content** is the message as the client sent it, with the leading dot
of each stuffed line removed (RFC 5321 §4.5.2), the terminating `.` line
gone, and CRLF line endings. On top, the server adds its Received field
(RFC 5321 §4.4):

```
Received: from bar.com ([192.0.2.10])
	by foo.com with ESMTP id 3f9c0a1b2c3d4e5f6a7b
	for <b@foo.com>; Fri, 2 Oct 2026 14:03:27 +0000
Subject: hi

body
```

- `from` is the EHLO or HELO name, then the client's address in brackets.
  Any character of the name that is not printable ASCII is written `?`.
- `with` is the protocol of RFC 3848: `SMTP` after HELO; `ESMTP` after EHLO,
  `ESMTPS` with TLS, `ESMTPA` with AUTH, `ESMTPSA` with both.
- `id` is the message's `id`, as in `250 2.0.0 OK queued as <id>`: 20
  hexadecimal characters.
- `for` names the recipient when there is exactly one, and only when it is
  printable ASCII with no `;`; otherwise it is left out.
- The date is in UTC.

`onData` is called at DATA, as soon as the client may send, with `content`
a stream of the message as it arrives. The server holds about 64 KiB of it:
when `onData` reads slower than the client sends, the server stops reading
the client until `onData` catches up. Read it to its end, then store the
message:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const path = `spool/${message.id}.eml`;
		try {
			await Bun.write(path, new Response(message.content));
		} catch (error) {
			await Bun.file(path).delete().catch(() => undefined); // never keep half a message
			throw error;
		}
	},
});

await server.listen({ port: 25 });
```

The client is told `250` only once `onData` read the stream to its clean
end **and** resolved without refusing. The stream errors, with an
`SmtpError`, when the message must not be delivered — and the client is
then refused whatever `onData` answers:

| `code` | Why | The client gets |
| --- | --- | --- |
| `MESSAGE_TOO_BIG` | the message passed `maxMessageSize` | `552 5.3.4 Message too big for system` |
| `BARE_LINE_BREAK` | a CR or LF that is not part of a CRLF: SMTP smuggling | `550 5.6.11 Bare CR or LF is not allowed in a message` |
| `CONNECTION_LOST` | the connection closed before the end — the client hung up, or the server closed it on idle `timeout` or a socket error | nothing: it is gone |
| `MESSAGE_NOT_READ` | `onData` answered before the end: a read it left running errors the moment it answers | `451 4.3.0 Local error in processing` |
| `HOOK_TIMEOUT` | `onData` read nothing for `hookTimeout` seconds, or did not answer within `hookTimeout` once the message ended — a late read must not keep a message the client will send again | `451 4.3.0 Local error in processing` |

The stream errors at once; the rest of the message is read and dropped,
and the refusal goes out when the client ends DATA with `<CRLF>.<CRLF>`,
since SMTP has no reply before then. The session goes on. `onData` itself must settle
within `hookTimeout` once the message ended, or the client gets `451 4.3.0`.

An `onData` that resolves without a refusal before it read the stream to
its end — or that cancels the stream — has not taken the message, so the
server does not say it did: it drops the rest, answers
`451 4.3.0 Local error in processing`, and `onError` gets an `SmtpError` of
code `MESSAGE_NOT_READ`. The client keeps the message and tries again. An
`onData` that refuses may do so without reading; its refusal is sent:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		if (message.envelope.to.length > 20) return reply(550, '5.7.1', 'Too many recipients for one message');
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes()); // read to the end
		return undefined;
	},
	onError: (error, session) => console.error(`[${session.id}]`, error), // MESSAGE_NOT_READ lands here
});

await server.listen({ port: 25 });
```

### When the refusal comes after the read

One refusal cannot reach the stream: `onData` read the message to its
clean end, then took longer than `hookTimeout` to answer — a slow scan, a
slow disk. The client gets `451 4.3.0` and will send the message again, but
the read already succeeded. `message.signal` covers that case and the
others: it aborts whenever the server refuses the message on `onData`'s
behalf.

| `signal.reason` | when |
| --- | --- |
| `SmtpError` `HOOK_TIMEOUT` | `onData` did not answer, or did not read, within `hookTimeout` |
| `SmtpError` `MESSAGE_NOT_READ` | `onData` accepted (answered `undefined`) before reading to the end, or after cancelling the stream |
| `SmtpError` `INVALID_HOOK_REPLY` | `onData` answered what is not a refusal, such as a `250` |
| what `onData` threw | `onData` threw; the client got `451` |
| `SmtpError` `CONNECTION_LOST` | the connection closed — the client hung up, or the server closed it on idle or a socket error — before the end of the message, or after it but before the reply |
| `SmtpError` `MESSAGE_TOO_BIG`, `BARE_LINE_BREAK` | the stream's own errors |

A refusal `onData` returns leaves the signal alone, whether it read the
message or not (a read it left running still errors with
`MESSAGE_NOT_READ`), unless the client never hears it: a later stream
failure (whose 552 or 550 replaces `onData`'s reply) or a closed
connection still aborts it, with that error. A client that leaves once
the reply was sent does not abort it. Check it, or listen for `abort`,
before keeping a message for good:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const bytes = await new Response(message.content).bytes();
		// A scan that may outlast hookTimeout.
		await fetch('http://127.0.0.1:3310/scan', { method: 'POST', body: bytes });
		if (message.signal.aborted) return; // the client was told 451: it will send it again
		await Bun.write(`spool/${message.id}.eml`, bytes);
	},
});

await server.listen({ port: 25 });
```

A check just before the commit narrows the race to that last write; it
cannot close it. RFC 5321 §6.1 prefers a duplicate to a loss, so the worst
case is a second copy, never a lost message.

To parse the message, collect it first and give the bytes to a parser.
`@bumail/mime`, a sibling package, is on the
[bumail roadmap](https://github.com/softistx/bumail/blob/develop/docs/roadmap.md);
until it is published, a parser of your own takes the same bytes:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const text = await new Response(message.content).text();
		const [head = ''] = text.split('\r\n\r\n', 1);
		const subject = /^subject: *(.*)$/im.exec(head)?.[1];
		console.log(subject, 'for', message.envelope.to);
	},
});

await server.listen({ port: 25 });
```

## Delivering into @bumail/store

[`@bumail/store`](https://github.com/softistx/bumail/tree/develop/packages/store) keeps
accounts, mailboxes and messages behind one contract, with a memory store
to start. `@bumail/smtp` does not depend on it: `onData` hands the stream
to the store, and the store reads it.

`message.content` already starts with the server's `Received` field, so it
goes into `addMessage` as it is — no buffer of your own, no header to
prepend. `addMessage` keeps nothing unless the stream ends cleanly, so a
message the server refuses mid-way (too big, a bare LF, the connection gone)
is stored nowhere, and the client hears the refusal.

```ts
import { createSmtpServer, reply } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';

const store = new MemoryMailStore();
const accounts = new Map<string, string>(); // address → account id
for (const name of ['alice', 'bob']) {
	const account = await store.createAccount(name);
	await store.createMailbox(account.id, { name: 'INBOX', role: 'inbox' });
	accounts.set(`${name}@example.com`, account.id);
}

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	// Refuse unknown users at RCPT, before any byte of the message.
	onRcptTo: (path) =>
		accounts.has(path.address.toLowerCase())
			? undefined
			: reply(550, '5.1.1', 'No such user here'),
	// One copy per recipient: the stream is teed, not buffered by you.
	async onData({ envelope, content }) {
		let rest = content;
		await Promise.all(
			envelope.to.map(async (to, index) => {
				let mine = rest;
				if (index < envelope.to.length - 1) [mine, rest] = rest.tee();
				const accountId = accounts.get(to.toLowerCase()) ?? '';
				const inbox = await store.findMailbox(accountId, 'inbox');
				await store.addMessage(accountId, inbox?.id ?? '', { content: mine });
			}),
		);
	},
	onError: (error, session) => console.error(`[${session.id}]`, error),
});
await server.listen({ port: 25 });
```

- **Every copy, or a 451.** `onData` resolves once each `addMessage` has
  read its branch to the end, so the `250` means every recipient has the
  message. If one `addMessage` throws, `onData` throws: the client gets
  `451 4.3.0` and sends again — and a recipient whose copy was already
  added gets it twice. A server that must avoid that queues the message
  once, then delivers from the queue.
- **A relay is refused before `onData`.** Without AUTH, a recipient
  outside `localDomains` gets `554 5.7.1 Relay access denied` at RCPT, so
  nothing reaches the store.
- **The memory store holds every message in memory.** It reads the stream
  into one `Blob`; a store on disk is on the store's roadmap.

## Authentication

`authenticate` turns on AUTH PLAIN (RFC 4616) and LOGIN, over TLS only.
It returns `true` to accept the credentials:

```ts
export interface Credentials {
	readonly mechanism: 'PLAIN' | 'LOGIN';
	readonly username: string;
	readonly password: string;
	/** PLAIN's authorization identity, when it differs from the username: the server refuses those. */
	readonly authorizationId?: string;
}
```

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

const server = createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	async authenticate(credentials) {
		const hash = users.get(credentials.username);
		return hash !== undefined && (await Bun.password.verify(credentials.password, hash));
	},
	// A user sends as themself only.
	onMailFrom: (path, session) =>
		path.address === `${session.user}@example.com`
			? undefined
			: reply(553, '5.7.1', 'Sender address not owned by you'),
	async onData(message) {
		await Bun.write(`outbox/${message.id}.eml`, await new Response(message.content).bytes());
	},
});

await server.listen({ port: 587 });
```

`session.user` becomes the `username`. A PLAIN authorization identity
other than the username is refused with `535 5.7.8` before `authenticate`
is asked: a session acts as the user it authenticated as, never as another.
So `authenticate` never sees an `authorizationId`; `decodePlain` still
returns it, for a server of your own.
The `AUTH=` parameter of MAIL FROM is accepted and ignored.

`authenticate` must return `true` to accept: any other value refuses. If it
throws or does not settle within `hookTimeout`, the client gets `454 4.7.0`
and `onError` is told.

| Reply | When |
| --- | --- |
| `334 ` / `334 VXNlcm5hbWU6` / `334 UGFzc3dvcmQ6` | a challenge: send the response, base64 |
| `235 2.7.0 Authentication successful` | `authenticate` returned `true`; AUTH is no longer advertised |
| `535 5.7.8 Authentication credentials invalid` | it returned anything else |
| `421 4.7.0 <hostname> Too many failed authentications, closing` | the third failure; the server hangs up |
| `454 4.7.0 Temporary authentication failure` | `authenticate` threw (RFC 4954 §6) |
| `538 5.7.11 Encryption required for requested authentication mechanism` | AUTH on a clear connection; the credentials are not read |
| `502 5.5.1 AUTH not available` | no `authenticate` option |
| `504 5.5.4 Unrecognized authentication type` | a mechanism other than PLAIN and LOGIN |
| `501 5.5.2 Cannot decode the response` | a response that is not valid base64 or PLAIN |
| `501 5.5.4 Syntax: AUTH mechanism [initial-response]` | AUTH with more than a mechanism and a response |
| `501 5.0.0 Authentication cancelled` | the client answered a challenge with `*` |
| `503 5.5.1 Already authenticated` / `AUTH not allowed during a transaction` | AUTH a second time, or between MAIL and the end of DATA |
| `503 Send EHLO first` | AUTH before EHLO, or after HELO; no enhanced code |

An authenticated session may send to any domain: that is what makes a
submission server useful. In `mx` mode, a session that authenticated may
relay too.

## TLS

```ts
export interface TlsOptions {
	readonly key: string | Uint8Array | Bun.BunFile;
	readonly cert: string | Uint8Array | Bun.BunFile;
}
```

`key` and `cert` are PEM, as `Bun.listen` takes them. Read them once, at
start-up, with `Bun.file().text()`; a missing file then fails before the
server listens, not at a client's first STARTTLS:

```ts
import { createSmtpServer } from '@bumail/smtp';

const tls = {
	key: await Bun.file('/etc/ssl/mx.example.com.key').text(),
	cert: await Bun.file('/etc/ssl/mx.example.com.crt').text(), // the chain, leaf first
};

const mx = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	tls,
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});

await mx.listen({ port: 25 });
```

For a local test, a self-signed pair:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=localhost \
  -keyout localhost.key -out localhost.crt
```

**STARTTLS** (RFC 3207) is offered when `tls` is set and the connection is
clear. After `220 2.0.0 Ready to start TLS` the server starts the handshake,
and the session starts over (§4.2): the client must send EHLO again, and the
transaction in progress is forgotten. Commands the client pipelined behind
STARTTLS, in clear, are dropped and never answered. The STARTTLS replies:

| Reply | When |
| --- | --- |
| `220 2.0.0 Ready to start TLS` | start the handshake |
| `454 4.7.0 TLS not available` | no `tls` option |
| `503 5.5.1 TLS already active` | the connection is already encrypted |
| `501 5.5.4 Syntax: STARTTLS` | STARTTLS with an argument |

**Implicit TLS** (RFC 8314) encrypts from the first byte: `implicitTls: true`
with `tls`, usually on 465. STARTTLS is not offered there — the connection
is already secure — and AUTH is offered at once.

An MX takes mail in clear as well as encrypted: senders on the Internet that
cannot do TLS still deliver. Whether to refuse them is policy — check
`session.secure` in a hook:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const tls = {
	key: await Bun.file('/etc/ssl/mx.example.com.key').text(),
	cert: await Bun.file('/etc/ssl/mx.example.com.crt').text(),
};

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	tls,
	onMailFrom: (_, session) =>
		session.secure ? undefined : reply(530, '5.7.0', 'Must issue a STARTTLS command first'),
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});

await server.listen({ port: 25 });
```

To run an MX on 25, submission on 587 and implicit TLS on 465 in one
process, create three servers with the same `tls`:

```ts
import { createSmtpServer, type ReceivedMessage, type SmtpServerOptions } from '@bumail/smtp';

const tls = {
	key: await Bun.file('/etc/ssl/mail.example.com.key').text(),
	cert: await Bun.file('/etc/ssl/mail.example.com.crt').text(),
};
const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

async function deliver(message: ReceivedMessage): Promise<void> {
	await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
}

const shared = {
	hostname: 'mail.example.com',
	localDomains: ['example.com'],
	tls,
	onData: deliver,
} satisfies SmtpServerOptions;

const submission = {
	...shared,
	mode: 'submission',
	async authenticate({ username, password }) {
		const hash = users.get(username);
		return hash !== undefined && (await Bun.password.verify(password, hash));
	},
} satisfies SmtpServerOptions;

await createSmtpServer(shared).listen({ port: 25 });
await createSmtpServer(submission).listen({ port: 587 });
await createSmtpServer({ ...submission, implicitTls: true }).listen({ port: 465 });
```

## Limits

| Limit | Default | Past it |
| --- | --- | --- |
| `maxMessageSize` | 25 MiB | `552 5.3.4` at MAIL when `SIZE=` says more; during DATA once the message is more — the content stream errors with `MESSAGE_TOO_BIG`, the rest is read and dropped, and the session goes on |
| `maxRecipients` | 100, the least RFC 5321 §4.5.3.1.8 asks a server to take | `452 4.5.3` for each extra recipient (RFC 5321 §4.5.3.1.10); the client sends the rest in another transaction |
| `maxConnections` | 1000 | `421 4.3.2` and the server hangs up, before the greeting and before `onConnect` |
| `maxErrors` | 10 | `421 4.7.0` and the server hangs up |
| `timeout` | 300 seconds, RFC 5321 §4.5.3.2.7's, counted from the client's last byte, or from the 220; Bun's socket timer ticks in steps of about 4 s, so the hang-up comes up to that much later | `421 4.4.2` and the server hangs up |
| `hookTimeout` | 60 seconds | `451 4.3.0` for that command; `onError` gets an `SmtpError` `HOOK_TIMEOUT` |
| `greetingDelay` | 0 seconds | not a limit but a wait: the 220 goes out that long after `onConnect` accepted; a client that talks in the meantime gets `554 <hostname> Talked before the greeting` and the server hangs up |

`greetingDelay` is a cheap filter against spam engines that do not wait for
the greeting (RFC 5321 §4.3.1), in the manner of Postfix's postscreen: a few
seconds is usual. Each waiting client holds one of `maxConnections`, and
the idle `timeout` runs during the wait, so keep the delay well below it:
`createSmtpServer` refuses a delay as long as `timeout`. The idle time starts
again when the 220 goes out, so the wait before it, `onConnect`'s included,
is never taken from the client's `timeout`.
`onConnect` runs first; its refusal goes out at once, without the delay:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

const blocked = new Set(['203.0.113.7']);

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	greetingDelay: 6,
	onConnect: (session) => (blocked.has(session.remoteAddress) ? reply(554, '5.7.1', 'Go away') : undefined),
	onData: async (message) => {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
});

await server.listen({ port: 25 });
```

Some limits are fixed: a command line is at most 2048 bytes (RFC 5321
§4.5.3.1.4 asks for 512 at least); a session gets three AUTH attempts; and
the server holds at most 64 KiB of a client's unread input, and of a
message `onData` has not read, before it stops reading that client. Replies
to a client that does not read them wait in the server while the connection
is open, none lost, and the server reads no further command until they went
out.

How the server hangs up depends on who decided. After `QUIT` it is
graceful: the `221` leaves whole, then the connection closes. When the
server decides — the idle `timeout`, `maxErrors`, three failed AUTH
attempts, a refusal from `onConnect`, a local error — it writes its reply
and closes at once: the connection is counted out of `connections` then and
there, and replies the client never read are dropped, the connection reset
if any were still waiting. When the server had stopped reading a client
that sent more than it could take, any hang-up, `QUIT`'s included, reads
again first, dropping whatever comes, and half-closes once the client's
input stops for 20 ms: a half-close does not complete over input left
unread, and on Linux a close over unread input is a reset that loses the
last reply. A client whose input went quiet for 20 ms within 500 ms of
the hang-up then still reads the last reply and the end. It waits 500 ms
at most: input not quiet for 20 ms by then, a client still sending or one
that stopped in the last 20 ms, is reset, so its slot is free by then too. So a client that
pipelines commands and stops reading cannot keep a slot of
`maxConnections` past its `timeout`.

Every hang-up is bounded, on a clear socket, on implicit TLS and after
STARTTLS alike. When the server decides, it never waits for the client to
answer its hang-up: the connection is counted out at once, even when the
client has stopped reading. When nothing is left queued, a client that reads later
still gets the last reply, then the end; when replies are still queued, a
forced close drops them and resets the connection. A graceful
close — after `QUIT`, or a reply that still has to leave — waits 5 seconds
at most for what is queued to go out; past that, what is left is dropped
and the connection reset. On TLS, once such queued replies have left, the
server closes when the client answers, within the same 5 seconds: a
half-close right then could drop the end of what Bun still holds in its
TLS buffer. So a `221` behind replies that are never read holds the slot
5 seconds, not until the `timeout`.

Stop a server with `stop()`; `stop(true)` also hangs up on every client,
those moved to TLS by STARTTLS included, as the idle timeout does.
`connections` counts the clients currently connected:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
await server.listen({ port: 2525 });

process.on('SIGTERM', () => {
	console.log(`stopping, ${server.connections} open`);
	server.stop(true);
});
```

## Sending mail: the client

`@bumail/smtp/client` is the other side of the conversation: `sendMail`
delivers one message to one destination and tells you what became of each
recipient. It shares the server's grammar — paths, replies, dot-stuffing,
SASL — and imports nothing of `@bumail/dns`, not even its types: a
resolver is needed only for MX delivery, and you pass it in (install
`@bumail/dns` for one).

- [Destinations](#destinations)
- [The session it runs](#the-session-it-runs)
- [TLS](#tls-1)
- [AUTH](#auth)
- [The message](#the-message)
- [What it resolves to, and what it rejects with](#what-it-resolves-to-and-what-it-rejects-with)
- [Delivery by MX](#delivery-by-mx)
- [Timeouts and limits](#timeouts-and-limits)
- [Trying it with Mailpit](#trying-it-with-mailpit)

### Destinations

```ts
import { nodeResolver } from '@bumail/dns';
import { sendMail } from '@bumail/smtp/client';

const message = 'From: a@example.com\r\nTo: b@example.org\r\nSubject: hi\r\n\r\nhello\r\n';

// A host: a smarthost, a submission server, a local Mailpit. Port 25 by
// default, 465 with secure: true.
await sendMail(message, { host: 'relay.example.net', port: 25, from: 'a@example.com', to: 'b@example.org' });

// A domain: its MX hosts, by preference, through the resolver. Port 25,
// and helo is required: your server's public name.
await sendMail(message, { domain: 'example.org', resolver: nodeResolver(), helo: 'mail.example.com', from: 'a@example.com', to: 'b@example.org' });
```

`from` is the envelope's reverse-path — `''` for the null sender of a
bounce — and `to` one recipient or more. Both are checked as RFC 5321 paths
before anything is sent, before the client even connects: an address
holding a CR, an LF, a NUL, any other control character or a `>`, in any
part, is refused with `INVALID_OPTION`, so it cannot inject a command. A
source route (`@a.example,@b.example:x@c.example`) is refused too, valid
or not: RFC 5321 §4.1.1.3 says a client should not send one, and the
address is written as it is given.

Code that keeps addresses to send to later — a queue — checks
each one when it takes it with `isMailbox`, which says yes to exactly the
addresses `sendMail` takes — it checks with the same predicate: an RFC 5321
Mailbox with no source route, no control character, no `>` and no lone
surrogate — so the refusal comes back to whoever gave it:

```ts
import { isMailbox } from '@bumail/smtp/client';

isMailbox('mary@example.net'); // true
isMailbox('a,b@example.net'); // false: sendMail would refuse it
```

One call is one destination. With `{ domain }`, every recipient should be
at that domain: group them by domain first, one `sendMail` each.

### The session it runs

| step | what the client sends | what it needs |
| --- | --- | --- |
| greeting | — | `220`; anything else is `REFUSED` |
| hello | `EHLO <helo>` | `250`; a 5xx gets `HELO <helo>` instead (RFC 5321 §4.1.4), a 4xx is `REFUSED` |
| TLS | `STARTTLS`, the handshake, `EHLO` again (RFC 3207 §4.2) | see [TLS](#tls-1) |
| AUTH | `AUTH PLAIN <initial>`, or `AUTH LOGIN` and two 334 steps | `235` |
| envelope | `MAIL FROM:<from> SIZE=n BODY=8BITMIME SMTPUTF8`, `RCPT TO:<to>` each | `250` to MAIL; `250` or `251` to a RCPT, any other reply rejects that recipient |
| content | `DATA`, the message dot-stuffed, `.` | `354`, then `250` |
| end | `QUIT` | the `221` is waited for 5 seconds at most |

- `helo` is the name this client gives: your server's public name, the
  one its address resolves back to. By MX it is required — an MX may
  refuse or penalise a name that does not resolve back to your address,
  and the machine's own name (`laptop.local`) is rarely one and would leak
  it — so `MxDestination` declares `helo: string`, and `{ domain }`
  without it does not compile; from JavaScript it is `INVALID_OPTION`. To a host
  (`{ host }`: a smarthost, Mailpit) it defaults to the machine's host
  name.
- `SIZE=` is sent when the server offers SIZE and the size is known: a
  string or bytes, or `size` for a stream. A message larger than the
  server's SIZE is refused before MAIL FROM, with `MESSAGE_TOO_BIG`.
- `BODY=8BITMIME` is sent whenever the server offers 8BITMIME (RFC 6152).
  Without it, a message with a byte above 127 fails with
  `EXTENSION_MISSING`: before MAIL FROM for a string or bytes, and by
  hanging up before the final dot for a stream.
- `SMTPUTF8` is sent when an address is not ASCII, or `smtputf8: true` asks
  for it (for UTF-8 header fields). A server without it fails the delivery
  with `EXTENSION_MISSING` (RFC 6531 §3.2).
- With PIPELINING (RFC 2920), MAIL FROM and every RCPT TO go in one write,
  and the replies are read in order. Without it, each waits for its reply.
  DATA always waits: if every recipient was refused, no content is sent.
- A server that refuses the message during DATA (a `552` before the dot)
  and hangs up is reported by its reply, `REFUSED`, not as a lost
  connection.
- After a refusal, the client says `QUIT` and hangs up. A message cut short —
  a stream that errors, a bare line break, a timeout — is never ended with
  the dot: the client hangs up, and the server drops what it had.

### TLS

| `tls` | STARTTLS | the certificate | default when |
| --- | --- | --- | --- |
| `'opportunistic'` | when offered; in clear otherwise, or when the server answers STARTTLS with anything but `220` | not checked (RFC 7435) | neither `auth` nor `secure` is given |
| `'required'` | needed: `TLS_UNAVAILABLE` without it | checked against `host`, or the MX host's name: `TLS_FAILED` | `auth` or `secure` is given |
| `'none'` | never | — | never |

`secure: true` is TLS from the first byte (RFC 8314, port 465): no
STARTTLS, and `tls` cannot be `'none'`. `ca` adds certificates to trust,
PEM, besides the system's: a private CA, or a test's self-signed one.

```ts
import { sendMail } from '@bumail/smtp/client';

const result = await sendMail('Subject: hi\r\n\r\nhello\r\n', {
	host: 'mail.internal.example',
	port: 587,
	tls: 'required',
	ca: await Bun.file('/etc/ssl/internal-ca.pem').text(),
	from: 'app@example.com',
	to: 'ops@example.com',
});
console.log(result.tls); // { verified: true }
```

`result.tls` is `false` in clear, else `{ verified }`: `true` when the
certificate checked out against the host name. With `'opportunistic'` it
says so too, but a certificate that does not check out is used all the
same — that is what opportunistic means. An opportunistic handshake that
fails is not retried in clear: it is `TLS_FAILED`, temporary, and by MX the
next host is tried.

Anything the server sends after its `220` to STARTTLS and before the
handshake is refused with `BAD_REPLY`: it would be read as if it came over
TLS (CVE-2011-0411).

### AUTH

`auth: { username, password }` uses PLAIN when the server offers it, else
LOGIN; `mechanism` picks one. The credentials go out only over TLS whose
certificate checked out, unless `allowPlaintextAuth` says otherwise. `auth` makes `tls: 'required'` the default, so a server
that does not offer STARTTLS fails earlier, with `TLS_UNAVAILABLE`.

`allowPlaintextAuth: true` lets AUTH go over a clear connection. It is for
a local test server, such as Mailpit with `--smtp-auth-allow-insecure`:
the password crosses the network in base64, which anyone on the path reads.
Never set it for a server elsewhere. With it, `tls` defaults to
`'opportunistic'`.

Without it, `auth` goes only with `tls: 'required'`: `tls: 'none'` would
send the password in clear, and `tls: 'opportunistic'` to a server whose
certificate is not checked, which an active attacker can intercept. Both
are refused with `INVALID_OPTION` before connecting. Leave `tls` out to
have the certificate checked, and pass `ca` for a private CA.

### The message

A `string` (sent as UTF-8), a `Uint8Array`, or a `ReadableStream` of
`Uint8Array` chunks: the whole RFC 5322 message, header fields first, lines
ending in CRLF. A stream is read as the server takes it, one chunk at a
time, so a large message never sits in memory whole.

- **Dot-stuffing** (RFC 5321 §4.5.2): a line starting with `.` gets one
  more; the server takes it off. A message whose last line has no CRLF gets
  one, since the terminator needs it.
- **Bare CR or LF**: refused with `BARE_LINE_BREAK`, as the server refuses
  it (SMTP smuggling). A string or bytes are checked before connecting; a
  stream as it is sent, and the client hangs up before the dot.
  `normalizeLineEnds: true` turns each bare CR or LF into CRLF instead.
- **Signing**: put the `DKIM-Signature` field `@bumail/auth`'s `signDkim`
  gives on top of the message before sending it. `sendMail` sends the
  bytes as they are, so a signature over them still verifies.

### What it resolves to, and what it rejects with

`sendMail` resolves once the server took the message for one recipient at
least:

```ts
import type { Reply } from '@bumail/smtp/client';

interface SendMailResult {
	accepted: { recipient: string; reply: Reply }[]; // 250 or 251 to RCPT TO
	rejected: { recipient: string; reply: Reply }[]; // any other reply
	reply: Reply; // to the final dot: { code: 250, status: '2.0.0', text: 'OK queued as …' }
	host: string; // the host, or the MX host, that took it
	port: number;
	tls: false | { verified: boolean };
	authenticated: boolean;
}
```

A rejected recipient with a 4xx is worth trying again later; with a 5xx it
is not. Every other outcome rejects with an `SmtpError`: its `code`, its
`message` (each is in [troubleshooting](troubleshooting.md#sending-mail-options)),
`temporary`, and, when a reply caused it, `reply` with its enhanced status
code (RFC 3463).

| `code` | when | `temporary` |
| --- | --- | --- |
| `INVALID_OPTION` | an option, an address or the message cannot be used | no |
| `BARE_LINE_BREAK` | the message holds a bare CR or LF | no |
| `MESSAGE_TOO_BIG` | larger than the server's SIZE | no |
| `EXTENSION_MISSING` | the message needs SMTPUTF8 or 8BITMIME, and the server lacks it | no |
| `AUTH_UNAVAILABLE` | credentials and no TLS, or no mechanism in common | no |
| `NULL_MX` | the domain's MX is the null MX (RFC 7505) | no |
| `DNS_FAILED` | the MX or address lookup failed | yes, unless the DNS said there is no such name |
| `REFUSED` | a 4xx or 5xx to the greeting, EHLO, AUTH, MAIL FROM, DATA or the dot | a 4xx yes, a 5xx no |
| `RECIPIENTS_REFUSED` | every recipient refused; `rejected` lists them | when one of the refusals is a 4xx |
| `CONNECTION_FAILED` | no TCP connection | yes |
| `CONNECTION_LOST` | the server hung up half-way | yes |
| `TIMEOUT` | a step's timeout, or the deadline | yes |
| `BAD_REPLY` | what the server sent is not an SMTP reply, or is too long | yes |
| `TLS_UNAVAILABLE` | `tls: 'required'` and no STARTTLS | yes |
| `TLS_FAILED` | the handshake failed, or the certificate did not check out | yes |

A queue retries what is `temporary` and bounces what is not. This client is
not one: it tries once and reports.

```ts
import { SmtpError, sendMail } from '@bumail/smtp/client';

try {
	await sendMail('Subject: hi\r\n\r\nhello\r\n', { host: 'relay.example.net', from: 'a@example.com', to: 'b@example.org' });
} catch (error) {
	if (!(error instanceof SmtpError)) throw error; // your own stream's error comes through as it is
	if (error.temporary) console.log('defer', error.code, error.reply?.status);
	else console.log('bounce', error.message);
}
```

### Delivery by MX

With `{ domain, resolver }`, `resolveMx` gives the hosts in the order to
try them (RFC 5321 §5.1):

- the MX records, the lowest preference first; equal ones in a random
  order, to spread the load;
- no MX record (the DNS said `NOT_FOUND`): the domain itself, the implicit
  MX;
- a null MX (`0 .`, RFC 7505): `NULL_MX` at once, no fallback to the
  domain's address;
- an MX lookup that failed: `DNS_FAILED`, temporary.

Each host's addresses come from the resolver too (A, then AAAA), and the
client connects to each address in turn, with TLS checked against the MX
host's name. It moves on after a failure that is temporary and came before
MAIL FROM — no connection, a dropped connection, a `421` greeting, a 4xx to
EHLO, no STARTTLS when it is required, a TLS failure — and stops at a 5xx
or once MAIL FROM was sent. It tries 10 addresses at most, and looks up
10 hosts at most — a host with no address counts too — so a domain with
hundreds of MX records costs no more than 10 hosts' lookups. Every lookup,
the MX one included, runs under `deadline`. When every host
failed, it rejects with the last failure; when none had an address, with
`DNS_FAILED`.

```ts
import { fixtureResolver } from '@bumail/dns';
import { resolveMx } from '@bumail/smtp/client';

const resolver = fixtureResolver({
	'example.org': {
		mx: [
			{ exchange: 'mx2.example.org', priority: 20 },
			{ exchange: 'mx1.example.org', priority: 10 },
		],
	},
});
console.log(await resolveMx('example.org', resolver));
// [{ host: 'mx1.example.org', priority: 10, implicit: false },
//  { host: 'mx2.example.org', priority: 20, implicit: false }]
```

Install `@bumail/dns` for MX delivery and pass one of its resolvers, or
pass any object with `mx`, `a` and `aaaa` (`MxResolver`, declared by shape
in this package, so its types never need `@bumail/dns`). A failure is
read by its `DnsError` shape (`name` and `code`), as `@bumail/dns`'s
`isTemporary` reads it: `TEMPORARY`, `TIMEOUT`, and anything that is not
a `DnsError` are temporary. A resolver that answers with an empty array
rather than `NOT_FOUND` is read the same way: no MX is the implicit MX, no
address is a permanent `DNS_FAILED`.

### Timeouts and limits

Every wait has a timeout, RFC 5321 §4.5.3.2's by default, in seconds. It
is the whole wait — from the command to the last line of its reply — so a
server that trickles a line at a time does not stretch it:

| `timeouts.` | waits for | default |
| --- | --- | --- |
| `connect` | the TCP connection, and each TLS handshake | 30 |
| `greeting` | the 220 | 300 |
| `command` | the replies to EHLO, HELO, STARTTLS, AUTH | 300 |
| `mail` | the reply to MAIL FROM | 300 |
| `rcpt` | the reply to each RCPT TO | 300 |
| `dataStart` | the 354 | 120 |
| `dataBlock` | the server to take each block of the message, and your stream to give the next one | 180 |
| `dataEnd` | the reply to the final dot | 600 |

`deadline` (1800 seconds by default) bounds the whole delivery, every host
and every DNS lookup together; each lookup is also bounded by the
resolver's own timeout. Each value
is a number of seconds above 0, fractions allowed, at most 2 147 483 (what
`setTimeout` can wait). A slow server ends in `TIMEOUT`, which is
temporary.

What a server sends is bounded too, whatever it sends: 2048 bytes a reply
line, 100 lines a reply, 1 MiB of replies a session. Past any of them, or
on a line that is not a reply, the client hangs up with `BAD_REPLY`. Each
line is read in one pass, so no reply can make the client spin.

### Trying it with Mailpit

[Mailpit](https://mailpit.axllent.org) is a mail server for tests: it keeps
whatever it receives and shows it on a web page. Start it:

```sh
docker run --rm -p 8025:8025 -p 1025:1025 axllent/mailpit
```

Then send to port 1025 — it offers no STARTTLS and needs no AUTH — and open
http://localhost:8025:

```ts
import { sendMail } from '@bumail/smtp/client';

await sendMail('From: a@example.com\r\nTo: b@example.org\r\nSubject: hi\r\n\r\nhello\r\n', {
	host: 'localhost',
	port: 1025,
	from: 'a@example.com',
	to: 'b@example.org',
});
```

In the bumail repository, `packages/smtp/examples/try-mailpit.ts` does the
same with a message signed by `@bumail/auth`'s `signDkim`, under a
throwaway Ed25519 key it makes for the run, and prints the DNS record that
would publish that key:

```sh
bun run build
bun packages/smtp/examples/try-mailpit.ts --host localhost --port 1025 --from me@example.com --to you@example.org
# or: MAILPIT_HOST=… MAILPIT_PORT=… MAIL_FROM=… MAIL_TO=… bun packages/smtp/examples/try-mailpit.ts
```

To try AUTH, start Mailpit with `--smtp-auth-accept-any
--smtp-auth-allow-insecure` and pass `auth` with `allowPlaintextAuth:
true`: Mailpit has no TLS by default, and that flag is for exactly this.

## Protocol helpers

The pieces the server is built from are exported, for a test, a client, or
a server of your own.

```ts
import {
	DataReader,
	decodePlain,
	formatReply,
	parseCommand,
	parsePath,
	parsePathCommand,
	reply,
} from '@bumail/smtp';

parseCommand('ehlo bar.com'); // { verb: 'EHLO', argument: 'bar.com' }

parsePathCommand('FROM:<Smith@bar.com> SIZE=500000 BODY=8BITMIME', 'FROM');
// { path: { address: 'Smith@bar.com', local: 'Smith', domain: 'bar.com' },
//   parameters: { SIZE: '500000', BODY: '8BITMIME' } }

parsePath('<Joe.Bloggs@EXAMPLE.Org>', false)?.address; // 'Joe.Bloggs@example.org'
parsePath('<>', true); // { address: '', local: '', domain: '' }: the null path, where allowed
parsePath('<>', false); // undefined

formatReply(reply(550, '5.7.1', ['a', 'b'])); // '550-5.7.1 a\r\n550 5.7.1 b\r\n'
formatReply(reply(250, '2.0.0', 'OK'), false); // '250 OK\r\n': no enhanced status

decodePlain('AHRpbQB0YW5zdGFhZnRhbnN0YWFm');
// { mechanism: 'PLAIN', username: 'tim', password: 'tanstaaftanstaaf' }

const reader = new DataReader();
const chunk = reader.write(new TextEncoder().encode('..x\r\n.\r\nQUIT\r\n'));
console.log(chunk.done, reader.bareLineBreaks);
// chunk.data: '.x\r\n', chunk.done: true, chunk.rest: 'QUIT\r\n'; reader.bareLineBreaks: 0
```

- `parsePathCommand` and `parsePath` return `undefined` when the syntax is
  wrong. `parsePath` takes UTF-8 addresses; whether a session may use one
  is SMTPUTF8's question. A control character or a `>` anywhere is wrong.
  Its third argument says what to do with a source route: `'discard'`, the
  default and what a server does, drops a valid `@domain(,@domain)*:`;
  `'refuse'`, what a client does, returns `undefined` for any route:
  `parsePath('<@a,@b:x@c.com>', false, 'refuse')` is `undefined`.
- `formatReply` replaces a CR or LF in the text with a space, so a reply
  text cannot start a second reply.
- `DataReader.write(chunk)` returns the unstuffed bytes, whether the
  terminator was read, and what followed it. It ends a message only at the
  exact `<CRLF>.<CRLF>`, and counts bare CRs and LFs in `bareLineBreaks`.
- `decodePlain` and `decodeLoginStep` return `undefined` for a response that
  is not valid base64, not UTF-8, or (for PLAIN) not
  `authzid NUL authcid NUL passwd` with a username and a password.

## The RFCs implemented

| Behaviour | RFC |
| --- | --- |
| the session, commands, replies, paths, the Received field | RFC 5321 |
| SIZE | RFC 1870 |
| PIPELINING | RFC 2920 |
| 8BITMIME | RFC 6152 |
| SMTPUTF8 | RFC 6531 |
| ENHANCEDSTATUSCODES and the codes themselves | RFC 2034, RFC 3463 |
| STARTTLS | RFC 3207 |
| implicit TLS | RFC 8314 |
| AUTH | RFC 4954 |
| SASL PLAIN | RFC 4616 |
| submission mode | RFC 6409 |
| `with ESMTPSA` in the Received field | RFC 3848 |
| the Received field's date | RFC 5322 §3.3 |
| the client's MX lookup and its order | RFC 5321 §5.1 |
| the client's null MX | RFC 7505 |
| the client's opportunistic TLS | RFC 7435 |

AUTH LOGIN has no RFC; it is the de facto mechanism most clients offer.
The specs next to each module are built on these RFCs' own examples —
Appendix D.1's session, RFC 4616's PLAIN responses — and name the section
each one comes from.

## What is not implemented

- **DSN** (RFC 3461). `RET`, `ENVID`, `NOTIFY` and `ORCPT` are refused with
  `555 5.5.4 <PARAM> is not supported`; DSN is not advertised, so a
  conforming client does not send them.
- **CHUNKING** (RFC 3030). `BDAT` is answered `500 5.5.2 Command
  unrecognized`; a client sends DATA instead.
- **A queue.** The client tries a destination once and reports;
  retrying a temporary failure is the caller's job until `@bumail/queue`.
- **Connection reuse.** The client opens one connection per message, and
  sends no `RSET`. Several messages to one destination over one session is
  on the [roadmap](roadmap.md).
- **DSN in the client.** It sends no `RET`, `ENVID`, `NOTIFY` or `ORCPT`.
- **CHUNKING in the client.** It sends DATA, never `BDAT`.
- **DANE and MTA-STS.** By MX, TLS is opportunistic; a policy that makes
  it required for a domain is for later.
- **Other SASL mechanisms in the client** — it speaks PLAIN and LOGIN.
- **Other SASL mechanisms** — CRAM-MD5, SCRAM, XOAUTH2 get `504 5.5.4`.
- **EXPN**, which gives away a list's members: `500 5.5.2`.
