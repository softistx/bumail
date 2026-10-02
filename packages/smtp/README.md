# @bumail/smtp

An SMTP server for Bun, on `Bun.listen`: RFC 5321 with PIPELINING, SIZE,
8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS or implicit TLS; AUTH
PLAIN and LOGIN, only once encrypted; hooks where your app accepts or
refuses a connection, a sender, a recipient or a message. It is never an
open relay. No dependency; `typescript` is an optional peer, for the types.

```sh
bun add @bumail/smtp
```

## An MX on port 25

Mail for your domains, from anyone; `onData` gets each message once it has
arrived, and the client is told `250` only after it returns.

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
		// message.content: the bytes, with this server's Received field on top
		await Bun.write(`spool/${message.id}.eml`, message.content);
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
		console.log(`${session.user} sent ${message.id} to ${message.envelope.to.join(', ')}`);
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
	onData: (message) => console.log('received', message.id),
});

await server.listen({ port: 465 });
```

## Hooks for policy

A hook returns nothing to accept, or a `reply(code, status, text)` with a
4xx or 5xx code to refuse. A hook that throws refuses with `451 4.3.0`, a
temporary failure, so the sender tries again later.

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
		mailboxes.has(path.address.toLowerCase()) ? undefined : reply(550, '5.1.1', 'No such user here'),
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, message.content);
	},
});
```

The server's own checks run first: `onRcptTo` is never asked about a
recipient the server already refused, relaying included.

## Limits

Every limit has a default; each must be a positive integer, or
`createSmtpServer` throws a `TypeError`.

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	maxMessageSize: 10 * 1024 * 1024, // bytes, announced as SIZE; default 25 MiB → 552 5.3.4
	maxRecipients: 50, // per message; default 100 → 452 4.5.3
	maxConnections: 200, // at once; default 1000 → 421 4.3.2
	maxErrors: 5, // failed commands before hanging up; default 10 → 421 4.7.0
	timeout: 120, // idle seconds; default 300 → 421 4.4.2
	onData: () => undefined,
});

const { port } = await server.listen({ port: 2525, hostname: '127.0.0.1' });
console.log(`listening on ${port}, ${server.connections} open`);
// later: server.stop(true) hangs up on every client too
```

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
  `550 5.6.11 Bare CR or LF is not allowed in a message`, and nothing is
  handed to `onData`.
- **Commands pipelined after STARTTLS are dropped.** Whatever the client
  sent in clear behind `STARTTLS` is discarded, never run (CVE-2011-0411),
  and the session starts over: EHLO again, no transaction, no user.

## Traps

- `mode: 'submission'` without `tls` accepts no mail: AUTH needs TLS, and
  MAIL needs AUTH. Give it `tls`.
- Ports 25, 465 and 587 are below 1024: binding them needs the privilege to,
  or a port forward from a higher one.
- `onData` receives the whole message as a `Uint8Array`, held in memory up
  to `maxMessageSize`; set the limit to what you are ready to hold per
  connection.

## API

| export | |
| --- | --- |
| `createSmtpServer(options)` | the server; throws a `TypeError` on a bad option |
| `SmtpServer` | `listen({ port, hostname? })`, `stop(closeConnections?)`, `connections` |
| `SmtpServerOptions` | `hostname`, `mode`, `localDomains`, `tls`, `implicitTls`, `authenticate`, the limits, and the hooks |
| `SmtpHooks` | `onConnect`, `onMailFrom`, `onRcptTo`, `onData` |
| `HookResult` | what a hook returns: `undefined` to accept, a `Reply` to refuse |
| `Session` | `id`, `remoteAddress`, `secure`, `helo`, `esmtp`, `user`, and `data` for your own state |
| `ReceivedMessage`, `Envelope` | what `onData` receives: `id`, `envelope` (`from`, `to`, `smtputf8`, `body`) and `content` |
| `TlsOptions` | `key` and `cert`, as `Bun.listen` takes them |
| `Credentials` | what `authenticate` receives: `mechanism`, `username`, `password`, `authorizationId?` |
| `reply(code, status, text)`, `Reply` | a reply, for a hook to refuse with |
| `formatReply(reply, enhanced?)` | a reply as sent on the wire, CRLF included |
| `parsePath(text, allowNull)`, `Path` | `<local@domain>` (RFC 5321 §4.1.2) to `{ address, local, domain }` |
| `parseCommand(line)`, `Command` | a command line to `{ verb, argument }` |
| `parsePathCommand(argument, 'FROM' \| 'TO')`, `PathCommand` | the argument of MAIL or RCPT to `{ path, parameters }` |
| `DataReader`, `DataChunk` | reads DATA: dot-unstuffing, the terminator, bare CR and LF counted |
| `decodePlain(response)`, `decodeLoginStep(response)` | SASL PLAIN (RFC 4616) and LOGIN responses to `Credentials` or text |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md): the session and every reply, hooks and their order, `Session.data`, what `onData` receives, TLS, the RFCs implemented and what is not.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/troubleshooting.md): every error, and the replies a client reports.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/roadmap.md): what is coming, and what is not planned.
