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
		mailboxes.has(path.address.toLowerCase()) ? undefined : reply(550, '5.1.1', 'No such user here'),
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
	onError: (error, session) => console.error(session.id, error),
});

await server.listen({ port: 25 });
```

The server's own checks run first: `onRcptTo` is never asked about a
recipient the server already refused, relaying included.

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
- **Bounded memory.** The server holds 64 KiB of a client's input and of a
  message at most, and stops reading the client past that; replies to a
  client that reads slowly wait in the server, none is lost.

## Traps

- **Read `message.content` to its end before keeping anything.** An
  `onData` that answers before the end gets the client `451 4.3.0`, never
  `250`, and `onError` an `SmtpError` (`MESSAGE_NOT_READ`). The stream ends
  in an `SmtpError` when the message must not be delivered — too big,
  smuggled, the client gone — and the client is then refused whatever
  `onData` answers. Something written before the stream ended may be a
  message the server refused: delete it when the read throws.
- **No read may outlive `onData`.** A read left running after `onData`
  answers ends in `MESSAGE_NOT_READ`, and one that starts after
  `hookTimeout` ends in `HOOK_TIMEOUT`: in both cases the client was told
  `451` and will send the message again, so keeping it would deliver it
  twice. Await the read inside `onData`.
- **An `onData` that read everything but answers after `hookTimeout`
  still gets the client `451`**, though its read ended cleanly. Only
  `message.signal` says so: it aborts whenever the message is refused for a
  reason `onData` did not answer itself (late, threw, not a refusal, the
  client gone before the reply). Check `if (message.signal.aborted) return;`
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
| `SmtpServer` | `listen({ port, hostname? })` (once; again throws `ALREADY_LISTENING`), `stop(closeConnections?)`, `connections` |
| `SmtpServerOptions` | `hostname`, `mode`, `localDomains`, `tls`, `implicitTls`, `authenticate`, the limits, `hookTimeout`, `greetingDelay`, `onError`, and the hooks |
| `SmtpError`, `SmtpErrorCode` | `code`: `INVALID_OPTION`, `ALREADY_LISTENING`, and what a content stream or `onError` can get: `MESSAGE_TOO_BIG`, `BARE_LINE_BREAK`, `CONNECTION_LOST`, `HOOK_TIMEOUT`, `INVALID_HOOK_REPLY`, `MESSAGE_NOT_READ` |
| `SmtpHooks` | `onConnect`, `onMailFrom`, `onRcptTo`, `onData` |
| `HookResult` | what a hook returns: `undefined` to accept, a `Reply` to refuse |
| `Session` | `id`, `remoteAddress`, `secure`, `helo`, `esmtp`, `user`, and `data` for your own state |
| `ReceivedMessage`, `Envelope` | what `onData` receives: `id`, `envelope` (`from`, `to`, `smtputf8`, `body`), `content`, a `ReadableStream<Uint8Array>`, and `signal`, an `AbortSignal` aborted when the message is refused for a reason `onData` did not answer itself |
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

These pages ship in the package, under `docs/`.

- [Index](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/guide.md): the session and every reply, hooks and their order, `Session.data`, what `onData` receives, TLS, the RFCs implemented and what is not.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/troubleshooting.md): every error, and the replies a client reports.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/smtp/docs/roadmap.md): what is coming, and what is not planned.
