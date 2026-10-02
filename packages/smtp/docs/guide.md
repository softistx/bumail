# Guide

How to run `@bumail/smtp` and what it does on the wire: the session and its
replies, the hooks, what a delivered message looks like, TLS, and the RFCs
behind each behaviour.

- [The smallest server](#the-smallest-server)
- [Options](#options)
- [The session, and what each reply means](#the-session-and-what-each-reply-means)
- [Hooks, and their order](#hooks-and-their-order)
- [Session.data](#sessiondata)
- [What onData receives](#what-ondata-receives)
- [Authentication](#authentication)
- [TLS](#tls)
- [Limits](#limits)
- [Protocol helpers](#protocol-helpers)
- [The RFCs implemented](#the-rfcs-implemented)
- [What is not implemented](#what-is-not-implemented)

## The smallest server

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData: (message) => {
		console.log(message.envelope.from, '→', message.envelope.to);
	},
});

const { port } = await server.listen({ port: 2525, hostname: '127.0.0.1' });
console.log(`listening on ${port}`);
```

`onData` is the only hook you must give: it is where a message goes once
received. `listen` resolves once the port is bound; `port: 0` picks a free
one, and the returned `port` says which.

```ts
export function createSmtpServer(options: SmtpServerOptions): SmtpServer;

export interface SmtpServer {
	/** Starts listening; resolves once the port is bound. Default hostname '0.0.0.0'. */
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
| `hostname` | `string` | required | the server's name, in its greeting, its EHLO reply and its Received fields; letters, digits, dots and hyphens |
| `localDomains` | `string[]` or `(domain) => boolean \| Promise<boolean>` | required | the domains it receives mail for; any other recipient is relaying, refused without AUTH |
| `mode` | `'mx' \| 'submission'` | `'mx'` | `mx` takes mail for `localDomains` from anyone; `submission` takes mail only from authenticated users (RFC 6409) |
| `tls` | `{ key, cert }` | none | turns on STARTTLS, or implicit TLS with `implicitTls` |
| `implicitTls` | `boolean` | `false` | TLS from the first byte (RFC 8314, port 465); needs `tls` |
| `authenticate` | `(credentials, session) => boolean \| Promise<boolean>` | none | turns on AUTH PLAIN and LOGIN, over TLS only; required by `submission` |
| `maxMessageSize` | `number` | 25 MiB | bytes; announced with SIZE |
| `maxRecipients` | `number` | `100` | recipients per message |
| `maxConnections` | `number` | `1000` | open connections at once |
| `maxErrors` | `number` | `10` | failed commands before the server hangs up |
| `timeout` | `number` | `300` | idle seconds before the server hangs up |
| `onConnect`, `onMailFrom`, `onRcptTo` | hooks | none | see [Hooks](#hooks-and-their-order) |
| `onData` | hook | required | receives each message |

`localDomains` is matched against the whole domain, without case:
`example.com` takes `b@EXAMPLE.COM`, not `b@sub.example.com` nor
`b@evilexample.com`. A function decides for itself, and is given the domain
in lower case:

```ts
import { createSmtpServer } from '@bumail/smtp';

const hosted = new Set(['example.com', 'example.org']);

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: async (domain) => hosted.has(domain) || domain.endsWith('.example.com'),
	onData: () => undefined,
});
```

`createSmtpServer` checks its options once and throws a `TypeError` for:

| Message | Cause |
| --- | --- |
| `createSmtpServer(): "<hostname>" is not a host name` | `hostname` has a character other than a letter, a digit, `.` or `-` |
| `createSmtpServer(): implicitTls needs tls: { key, cert }` | `implicitTls: true` without `tls` |
| `createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate` | `mode: 'submission'` without `authenticate` |
| `createSmtpServer(): <limit> must be a positive integer, not <value>` | a limit that is `0`, negative, fractional or `NaN` |

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
| `501 5.5.4 Syntax: EHLO hostname` | the EHLO or HELO argument is not a domain or an address literal |
| `250 2.1.0 OK` | MAIL FROM accepted |
| `250 2.1.5 OK` | RCPT TO accepted |
| `354 End data with <CR><LF>.<CR><LF>` | DATA: send the message |
| `250 2.0.0 OK queued as <id>` | the message was taken: `onData` returned without refusing |
| `250 2.0.0 OK` | RSET (the transaction is forgotten) or NOOP |
| `252 2.5.0 Cannot VRFY user; …` | VRFY: no account is confirmed nor denied (RFC 5321 §3.5.3) |
| `214 2.0.0 See RFC 5321` | HELP |
| `221 2.0.0 <hostname> closing connection` | QUIT |
| `503 5.5.1 Send EHLO first` | MAIL or AUTH before EHLO |
| `503 5.5.1 Nested MAIL command` | a second MAIL in one transaction |
| `503 5.5.1 Send MAIL first` | RCPT or DATA before MAIL |
| `554 5.5.1 No valid recipients` | DATA with no recipient accepted |
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
| `451 4.3.0 Local error in processing` | a hook threw |
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
except `452 4.5.3`, `454 4.7.0 Temporary authentication failure`, and the
refusals at the end of DATA (`552 5.3.4`, `550 5.6.11`). A refusal from
your own hook never counts.

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
| `onConnect` | when a client connects, before the greeting | the connection count | replaces the greeting; then the server hangs up |
| `authenticate` | at AUTH | TLS, EHLO, no transaction in progress | see [Authentication](#authentication) |
| `onMailFrom` | at each MAIL FROM | EHLO, AUTH in `submission`, syntax, parameters, SIZE, SMTPUTF8 | refuses the sender; the client may try another MAIL |
| `onRcptTo` | at each RCPT TO | MAIL, syntax, SMTPUTF8, `maxRecipients`, **relaying** | refuses that recipient; the others stand |
| `onData` | once the whole message arrived | size, bare CR or LF | refuses the message; the next transaction starts clean |

A hook is never asked about what the server already refused: `onRcptTo`
never sees a recipient refused for relaying, so no hook can open the relay.

Hooks run one at a time, in the order of the commands. A client that
pipelines gets every reply in order: a slow `onMailFrom` holds the replies to
the commands behind it.

A hook that throws, or whose promise rejects, refuses with
`451 4.3.0 Local error in processing` — a temporary failure, so the sender
keeps the message and tries again. Let `onData` throw when the message could
not be stored:

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
		await Bun.write(`spool/${message.id}.eml`, message.content); // a throw here: 451 4.3.0
	},
});
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
the path is `b@c.example`.

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
the server never reads it.

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
	onData: () => undefined,
});

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
	/** The message as received, dot-unstuffed, with the server's Received field first. */
	readonly content: Uint8Array;
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
- `for` names the recipient when there is exactly one; with several, it is
  left out.
- The date is in UTC.

`onData` runs before the server answers the end of DATA: the client is told
`250` only once `onData` returned without refusing. Store or queue the
message before returning. To parse it, `@bumail/mime` reads the bytes as they
are:

```ts
import { parseMessage } from '@bumail/mime';
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData(message) {
		const parsed = parseMessage(message.content);
		console.log(parsed.headers.text('subject'), 'for', message.envelope.to);
	},
});
```

A message over `maxMessageSize`, or one holding a bare CR or LF, never
reaches `onData`: it is read to its end, refused, and the session goes on.

## Authentication

`authenticate` turns on AUTH PLAIN (RFC 4616) and LOGIN, over TLS only.
It returns `true` to accept the credentials:

```ts
export interface Credentials {
	readonly mechanism: 'PLAIN' | 'LOGIN';
	readonly username: string;
	readonly password: string;
	/** PLAIN's authorization identity, when it differs from the username. */
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
		if (credentials.authorizationId !== undefined) return false; // no acting as someone else
		const hash = users.get(credentials.username);
		return hash !== undefined && (await Bun.password.verify(credentials.password, hash));
	},
	// A user sends as themself only.
	onMailFrom: (path, session) =>
		path.address === `${session.user}@example.com`
			? undefined
			: reply(553, '5.7.1', 'Sender address not owned by you'),
	onData: () => undefined,
});
```

`session.user` becomes the `username`; the server ignores
`authorizationId`, so refuse it in `authenticate` unless you mean to allow
it. The `AUTH=` parameter of MAIL FROM is accepted and ignored.

| Reply | When |
| --- | --- |
| `334 ` / `334 VXNlcm5hbWU6` / `334 UGFzc3dvcmQ6` | a challenge: send the response, base64 |
| `235 2.7.0 Authentication successful` | `authenticate` returned `true`; AUTH is no longer advertised |
| `535 5.7.8 Authentication credentials invalid` | it returned anything else |
| `421 4.7.0 Too many failed authentications, closing` | the third failure; the server hangs up |
| `454 4.7.0 Temporary authentication failure` | `authenticate` threw (RFC 4954 §6) |
| `538 5.7.11 Encryption required for requested authentication mechanism` | AUTH on a clear connection; the credentials are not read |
| `502 5.5.1 AUTH not available` | no `authenticate` option |
| `504 5.5.4 Unrecognized authentication type` | a mechanism other than PLAIN and LOGIN |
| `501 5.5.2 Cannot decode the response` | a response that is not valid base64 or PLAIN |
| `501 5.0.0 Authentication cancelled` | the client answered a challenge with `*` |
| `503 5.5.1 Already authenticated` / `AUTH not allowed during a transaction` | AUTH a second time, or between MAIL and the end of DATA |

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

const mx = createSmtpServer({ hostname: 'mx.example.com', localDomains: ['example.com'], tls, onData: () => undefined });
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
	onData: () => undefined,
});
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
	await Bun.write(`spool/${message.id}.eml`, message.content);
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
| `maxMessageSize` | 25 MiB | `552 5.3.4` at MAIL when `SIZE=` says more; after DATA when the message is more. The message is read to its end, only what fits is kept, and the session goes on |
| `maxRecipients` | 100, the least RFC 5321 §4.5.3.1.8 asks a server to take | `452 4.5.3` for each extra recipient (RFC 5321 §4.5.3.1.10); the client sends the rest in another transaction |
| `maxConnections` | 1000 | `421 4.3.2` and the server hangs up, before the greeting and before `onConnect` |
| `maxErrors` | 10 | `421 4.7.0` and the server hangs up |
| `timeout` | 300 seconds, RFC 5321 §4.5.3.2.7's | `421 4.4.2` and the server hangs up |

Two limits are fixed: a command line is at most 2048 bytes (RFC 5321
§4.5.3.1.4 asks for 512 at least), and a session gets three AUTH attempts.

Stop a server with `stop()`; `stop(true)` also hangs up on every client.
`connections` counts the clients currently connected:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({ hostname: 'mx.example.com', localDomains: ['example.com'], onData: () => undefined });
await server.listen({ port: 2525 });

process.on('SIGTERM', () => {
	console.log(`stopping, ${server.connections} open`);
	server.stop(true);
});
```

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
// chunk.data: '.x\r\n', chunk.done: true, chunk.rest: 'QUIT\r\n'; reader.bareLineBreaks: 0
```

- `parsePathCommand` and `parsePath` return `undefined` when the syntax is
  wrong. `parsePath` takes UTF-8 addresses; whether a session may use one
  is SMTPUTF8's question.
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
- **The client.** This package receives mail; it does not send it to other
  servers. Outbound delivery is on the [roadmap](roadmap.md).
- **Other SASL mechanisms** — CRAM-MD5, SCRAM, XOAUTH2 get `504 5.5.4`.
- **EXPN**, which gives away a list's members: `500 5.5.2`.
