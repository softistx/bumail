# Troubleshooting

Each entry is headed by the text you see: the message of the error thrown,
or the reply the server sends, as a client or a log prints it. `…` stands
for the part that varies, often the server's `hostname`.

A reply carries its enhanced status code (`5.7.1`, RFC 3463) only after
`EHLO`. After `HELO`, or before either, the same reply comes without it:
`554 Relay access denied`, not `554 5.7.1 Relay access denied`.

**Configuration**

- [`TypeError: createSmtpServer(): "…" is not a host name`](#typeerror-createsmtpserver--is-not-a-host-name)
- [`TypeError: createSmtpServer(): implicitTls needs tls: { key, cert }`](#typeerror-createsmtpserver-implicittls-needs-tls--key-cert-)
- [`TypeError: createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate`](#typeerror-createsmtpserver-submission-takes-mail-only-from-authenticated-users-so-it-needs-authenticate)
- [`TypeError: createSmtpServer(): … must be a positive integer, not …`](#typeerror-createsmtpserver--must-be-a-positive-integer-not-)

**Relaying and authentication**

- [`554 5.7.1 Relay access denied`](#554-571-relay-access-denied)
- [`AUTH` is missing from the EHLO reply](#auth-is-missing-from-the-ehlo-reply)
- [`538 5.7.11 Encryption required for requested authentication mechanism`](#538-5711-encryption-required-for-requested-authentication-mechanism)
- [`530 5.7.0 Authentication required`](#530-570-authentication-required)
- [`535 5.7.8 Authentication credentials invalid`](#535-578-authentication-credentials-invalid)
- [`454 4.7.0 Temporary authentication failure`](#454-470-temporary-authentication-failure)
- [`421 4.7.0 Too many failed authentications, closing`](#421-470-too-many-failed-authentications-closing)

**Commands**

- [`503 Send EHLO first`](#503-send-ehlo-first)
- [`555 5.5.4 … is not supported`](#555-554--is-not-supported)
- [`555 … needs EHLO`](#555--needs-ehlo)
- [`553 5.6.7 A non-ASCII address needs SMTPUTF8`](#553-567-a-non-ascii-address-needs-smtputf8)
- [`500 5.5.6 Line too long`](#500-556-line-too-long)

**Messages**

- [`550 5.6.11 Bare CR or LF is not allowed in a message`](#550-5611-bare-cr-or-lf-is-not-allowed-in-a-message)
- [`552 5.3.4 Message too big for system`](#552-534-message-too-big-for-system)
- [`452 4.5.3 Too many recipients`](#452-453-too-many-recipients)

**Hooks**

- [`451 4.3.0 Local error in processing`](#451-430-local-error-in-processing)
- [`421 4.3.0 Local error, closing`](#421-430-local-error-closing)

**Connections**

- [`421 4.7.0 … Too many errors, closing`](#421-470--too-many-errors-closing)
- [`421 4.3.2 … Too many connections, try later`](#421-432--too-many-connections-try-later)
- [`421 4.4.2 … Idle too long, closing`](#421-442--idle-too-long-closing)

## Configuration

Each of these is thrown by `createSmtpServer(options)` itself, before
anything listens.

### `TypeError: createSmtpServer(): "…" is not a host name`

**When**: `hostname` holds anything but letters, digits, dots and hyphens:
an empty string, a port (`mx.example.com:25`), a URL, an underscore, a
space, or an address literal in brackets.

**Why**: `hostname` is the server's own name. It is written into the
greeting, the EHLO reply and every `Received` field, so it must be a plain
domain name. It is not the address to bind to.

**Fix**: give the name; bind with `listen`:

```ts
import { createSmtpServer } from '@bumail/smtp';

const server = createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData: async (message) => {
		await deliver(message);
	},
});
await server.listen({ port: 25, hostname: '0.0.0.0' });
```

### `TypeError: createSmtpServer(): implicitTls needs tls: { key, cert }`

**When**: `implicitTls: true` without `tls`.

**Why**: implicit TLS (port 465, RFC 8314) starts TLS on the first byte,
so it needs a key and a certificate.

**Fix**:

```ts
createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	implicitTls: true,
	tls: { key: Bun.file('key.pem'), cert: Bun.file('cert.pem') },
	authenticate: async ({ username, password }) => checkUser(username, password),
	localDomains: ['example.com'],
	onData: async (message) => {
		await queue(message);
	},
});
```

Leave `implicitTls` out on port 25 or 587: `tls` alone offers STARTTLS.

### `TypeError: createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate`

**When**: `mode: 'submission'` without `authenticate`.

**Why**: a submission server refuses `MAIL FROM` until the client has
authenticated. With nothing to check credentials, it could take no mail at
all.

**Fix**: give `authenticate`, and `tls` with it: AUTH is offered only over
TLS, so a submission server without `tls` takes no mail either. See the
snippet above. For mail from the Internet to your own domains, use
`mode: 'mx'` (the default) instead.

### `TypeError: createSmtpServer(): … must be a positive integer, not …`

**When**: `maxMessageSize`, `maxRecipients`, `maxConnections`, `maxErrors`
or `timeout` is `0`, negative, a fraction, `NaN` or `Infinity`.

**Why**: each is a bound on what a client can make the server do, and none
can be switched off.

**Fix**: pass integers, or leave an option out for its default:

```ts
createSmtpServer({
	// …
	maxMessageSize: 50 * 1024 * 1024, // bytes; default 25 MiB
	maxRecipients: 500, // default 100
	maxConnections: 2000, // default 1000
	maxErrors: 20, // default 10
	timeout: 600, // seconds, not milliseconds; default 300
});
```

`timeout` is in seconds: `300_000` is accepted, and means 83 hours.

## Relaying and authentication

### `554 5.7.1 Relay access denied`

**When**: `RCPT TO` names an address whose domain is not in `localDomains`,
and the session has not authenticated. A `DATA` after it, with no other
recipient, gets `554 5.5.1 No valid recipients`. Each denial counts toward
`maxErrors`.

**Why**: the server is never an open relay. Without AUTH it takes mail only
for the domains it hosts, and no option or hook changes that: `onRcptTo`
runs after this check, and cannot accept a recipient it refused.

**Fix**, as the operator: list every domain you receive mail for. The
comparison ignores case and is exact: `example.com` does not cover
`mail.example.com`, so use a function to cover subdomains:

```ts
createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: (domain) =>
		domain === 'example.com' || domain.endsWith('.example.com'),
	onData: async (message) => {
		await deliver(message);
	},
});
```

**Fix**, as a client: to send to another domain, authenticate first,
usually on the submission port (587 with STARTTLS, or 465). Port 25 of an
MX takes mail only for its own domains.

### `AUTH` is missing from the EHLO reply

**When**: the `250-` lines answering `EHLO` list no `AUTH PLAIN LOGIN`, and
the client says the server does not support authentication. `AUTH` itself
gets `502 5.5.1 AUTH not available`, or
[`538 5.7.11`](#538-5711-encryption-required-for-requested-authentication-mechanism).

**Why**: `AUTH` is offered only when all three hold:

- the server was given `authenticate` (otherwise `502 5.5.1 AUTH not available`);
- the connection is encrypted: `implicitTls`, or after `STARTTLS`. On port
  25 or 587, the EHLO sent before STARTTLS never lists AUTH;
- the session has not authenticated yet.

Without `tls`, the server offers no `STARTTLS` either, and `STARTTLS` gets
`454 4.7.0 TLS not available`: AUTH can never be offered.

**Fix**, as the operator: give both `tls` and `authenticate`:

```ts
createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	tls: { key: Bun.file('key.pem'), cert: Bun.file('cert.pem') },
	authenticate: async ({ username, password }) => checkUser(username, password),
	localDomains: ['example.com'],
	onData: async (message) => {
		await queue(message);
	},
});
```

**Fix**, as a client: turn on STARTTLS (or implicit TLS on 465), and read
the EHLO reply that follows the TLS handshake, not the one before it.

### `538 5.7.11 Encryption required for requested authentication mechanism`

**When**: `AUTH` on a connection that is not encrypted, on a server that
has `authenticate`.

**Why**: a password in clear can be read by anyone on the path. AUTH is
refused, and not advertised, before TLS (RFC 4954 §4).

**Fix**, as a client: `STARTTLS`, then `EHLO` again, then `AUTH`:

```text
C: EHLO client.example.org
S: 250 STARTTLS
C: STARTTLS
S: 220 2.0.0 Ready to start TLS
   (TLS handshake)
C: EHLO client.example.org
S: 250 AUTH PLAIN LOGIN
C: AUTH PLAIN <base64 of \0user\0password>
S: 235 2.7.0 Authentication successful
```

**Fix**, as the operator: give `tls`, so the server can offer STARTTLS; see
[`AUTH` is missing from the EHLO reply](#auth-is-missing-from-the-ehlo-reply).

### `530 5.7.0 Authentication required`

**When**: `MAIL FROM` before a successful `AUTH`, on a server in
`mode: 'submission'`.

**Why**: a submission server takes mail only from its own users (ports 587
and 465). It is not the server other MTAs deliver to.

**Fix**, as a client: authenticate after STARTTLS and EHLO, then send
`MAIL FROM`. Check that the client is set to use AUTH, and that it is
talking to the submission port, not to the MX.

**Fix**, as the operator: to receive mail from the Internet for your own
domains, run a second server in `mode: 'mx'` (the default) on port 25.

### `535 5.7.8 Authentication credentials invalid`

**When**: `AUTH PLAIN` or `AUTH LOGIN`, when `authenticate` answered
anything but `true`. Each one counts toward `maxErrors`, and the third in a
session [closes it](#421-470-too-many-failed-authentications-closing).

**Why**: the server accepts the credentials only when `authenticate`
returns, or resolves to, exactly `true`. A user object, a non-empty string
or `1` counts as a refusal.

**Fix**, as the operator: return a boolean:

```ts
authenticate: async ({ username, password }) => {
	const user = await users.find(username);
	return user !== undefined && (await Bun.password.verify(password, user.hash));
},
```

`credentials.authorizationId` holds PLAIN's authorization identity when the
client sent one that differs from the username; decide there whether the
user may act as it.

**Fix**, as a client: check the username and password, and that the
client sends PLAIN or LOGIN: other mechanisms get
`504 5.5.4 Unrecognized authentication type`.

### `454 4.7.0 Temporary authentication failure`

**When**: `AUTH`, when `authenticate` threw or its promise rejected. It
does not count as a failed attempt, nor toward `maxErrors`.

**Why**: an error in the check is the server's failure, not the client's
(RFC 4954 §6), so the client is told to try again later. The server does
not log the error.

**Fix**, as the operator: catch and log inside `authenticate` to see why,
then fix the store it reads:

```ts
authenticate: async ({ username, password }) => {
	try {
		return await checkUser(username, password);
	} catch (error) {
		console.error('authenticate', error);
		throw error;
	}
},
```

**Fix**, as a client: retry later.

### `421 4.7.0 Too many failed authentications, closing`

**When**: the third `535 5.7.8` in one session. The server hangs up.

**Why**: it bounds password guessing on one connection. The limit is
three, and is not an option. A response that is not valid base64 gets
`501 5.5.2 Cannot decode the response` and does not count.

**Fix**, as a client: fix the credentials, then connect again.

**Fix**, as the operator: see
[`535 5.7.8`](#535-578-authentication-credentials-invalid): a check that
never answers `true` refuses everyone.

## Commands

### `503 Send EHLO first`

**When**:

- `MAIL FROM` before `EHLO` or `HELO`;
- `MAIL FROM` or `AUTH` after `STARTTLS`, before a new `EHLO`;
- `AUTH` after `HELO`: AUTH needs `EHLO`.

It never carries an enhanced status code, since no EHLO is in effect when
it is sent.

**Why**: STARTTLS starts the session over (RFC 3207 §4.2): the greeting,
the EHLO and any transaction from before TLS are forgotten.

**Fix**, as a client: send `EHLO` after connecting and again after the TLS
handshake. Every common client library does; a hand-written client must:

```text
C: STARTTLS
S: 220 2.0.0 Ready to start TLS
   (TLS handshake)
C: EHLO client.example.org
```

### `555 5.5.4 … is not supported`

**When**: `MAIL FROM` with a parameter other than `SIZE`, `BODY`,
`SMTPUTF8` and `AUTH`, such as `RET` or `ENVID`; or `RCPT TO` with any
parameter, such as `NOTIFY` or `ORCPT`; or `SMTPUTF8` given a value.

**Why**: the server supports only the extensions its EHLO lists. Delivery
status notifications (DSN, RFC 3461) are not among them.

**Fix**, as a client: send only the parameters the EHLO reply announces;
turn off DSN options (`NOTIFY`, `RET`, `ENVID`, `ORCPT`) for this server.

### `555 … needs EHLO`

**When**: any `MAIL FROM` parameter, such as `SIZE=` or `BODY=`, after
`HELO`.

**Why**: parameters are ESMTP (RFC 5321 §4.1.2); a client that said `HELO`
declared it does not speak it.

**Fix**, as a client: greet with `EHLO`, or send no parameters.

### `553 5.6.7 A non-ASCII address needs SMTPUTF8`

**When**: `MAIL FROM` or `RCPT TO` with an address holding a non-ASCII
character, such as `jörg@example.com`, when the `MAIL FROM` of the
transaction did not carry `SMTPUTF8`.

**Why**: RFC 6531 lets a UTF-8 address through only once the client has
said it will send one, so that a server down the line that cannot take it
is never handed one.

**Fix**, as a client: add `SMTPUTF8` to `MAIL FROM` (after `EHLO`, which
lists it):

```text
C: MAIL FROM:<jörg@example.com> SMTPUTF8
S: 250 2.1.0 OK
```

### `500 5.5.6 Line too long`

**When**: a command line longer than 2048 bytes. The rest of that line is
skipped, and the failure counts toward `maxErrors`. Message content after
`DATA` has no such limit.

**Why**: the server holds a command line in memory before reading it, so
the line is bounded. RFC 5321 §4.5.3.1.4 asks for 512 bytes at least.

**Fix**, as a client: keep commands short. The usual cause is message
content sent as commands: a client that pipelines the message after a
`DATA` that was refused, such as `554 5.5.1 No valid recipients`. Wait for
`354` before sending the message.

## Messages

### `550 5.6.11 Bare CR or LF is not allowed in a message`

**When**: the reply to the end of `DATA`, when the message held a CR or an
LF that was not part of a CRLF pair. Nothing is delivered and `onData` is
not called; the session goes on.

**Why**: a bare line break is how SMTP smuggling hides a second message
inside the first: servers that read line ends differently disagree where
the message ends. The server refuses such a message rather than guess.

**Fix**, as a client: send every line ending as CRLF, headers and body,
and encode binary content (base64 or quoted-printable). There is no
option to accept it.

### `552 5.3.4 Message too big for system`

**When**:

- `MAIL FROM:<…> SIZE=n` with `n` above `maxMessageSize`: refused at once;
- at the end of `DATA`, when the message is larger than `maxMessageSize`.
  The server reads the message to its end, keeps none of it past the
  limit, then refuses it; `onData` is not called.

**Why**: `maxMessageSize` (25 MiB by default) bounds what one message can
cost. The EHLO reply announces it as `SIZE n`. The size is counted after
dot-unstuffing, without the server's own `Received` field.

**Fix**, as the operator: raise the limit:

```ts
createSmtpServer({
	// …
	maxMessageSize: 50 * 1024 * 1024,
});
```

**Fix**, as a client: read `SIZE` from the EHLO reply and send smaller
messages, such as a link instead of a large attachment. Base64 makes an
attachment about a third larger than the file.

### `452 4.5.3 Too many recipients`

**When**: `RCPT TO` past `maxRecipients` in one transaction (100 by
default). The recipients accepted before it stay accepted, and it does not
count toward `maxErrors`.

**Why**: RFC 5321 §4.5.3.1.10: a server bounds recipients per message, and
a 452 tells the client to send the rest in another transaction.

**Fix**, as a client: send `DATA` for the recipients accepted, then the
same message again in a new transaction for the rest. Most MTAs and client
libraries do it on their own.

**Fix**, as the operator: raise `maxRecipients`. Below 100, some clients
will not split their recipients and fail instead.

## Hooks

### `451 4.3.0 Local error in processing`

**When**: one of the hooks threw, or its promise rejected:

- `onConnect`: the connection gets `451 Local error in processing` in place
  of its greeting, without an enhanced code, and is closed;
- `onMailFrom`, `onRcptTo`: that command is refused;
- `onData`: the message is refused, and the client keeps it.

**Why**: a hook that fails has neither accepted nor refused, so the server
answers with a temporary failure: a client tries again later rather than
lose the message. The error itself is not logged.

**Fix**, as the operator: catch inside the hook, log, and answer the reply
you mean:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

createSmtpServer({
	// …
	onData: async (message) => {
		try {
			await store(message);
		} catch (error) {
			console.error('onData', message.id, error);
			return reply(451, '4.3.0', 'Try again later');
		}
	},
});
```

**Fix**, as a client: retry later. An MTA queues the message and does so on
its own.

### `421 4.3.0 Local error, closing`

**When**: during a session, then the server hangs up. The reply carries
no enhanced code before EHLO.

**Why**: the server failed while handling a command. A cause in your
options: a `localDomains` function that throws or rejects. Unlike the
hooks, it is not caught on its own, and fails the whole connection. Any
other cause is a bug in this package.

**Fix**: make `localDomains` answer without throwing:

```ts
localDomains: async (domain) => {
	try {
		return await domains.has(domain);
	} catch (error) {
		console.error('localDomains', error);
		return false;
	}
},
```

If `localDomains` is a list, report the bug at
[the issue tracker](https://github.com/softistx/bumail/issues), with the
session transcript and the `@bumail/smtp` and Bun versions.

## Connections

### `421 4.7.0 … Too many errors, closing`

**When**: the `maxErrors`-th failed command of a session (10 by default).
The reply replaces the reply to that command, and the server hangs up.

**Why**: a client that keeps failing is broken or probing. What counts:
unknown commands, bad syntax, commands out of order, relay denials,
`535`, `553`, `555`, `500 5.5.6`, and `552` at `MAIL FROM`. What does not:
a refusal from a hook, `452`, `454 4.7.0 Temporary authentication failure`,
and the replies to the end of `DATA`.
The count is per connection and is never reset.

**Fix**, as a client: read the replies before the 421. A common cause is
message content pipelined after a refused `DATA`, each line read as a
command.

**Fix**, as the operator: raise `maxErrors` if legitimate clients reach it,
such as an MTA sending to many recipients of which most are refused.

### `421 4.3.2 … Too many connections, try later`

**When**: on connecting, in place of the greeting, when `maxConnections`
(1000 by default) are already open. The server hangs up.

**Why**: each connection costs memory and a socket. The 421 tells an MTA
to retry later.

**Fix**, as the operator: raise `maxConnections`, or look for clients that
hold connections open without `QUIT`. `server.connections` gives the
number open.

**Fix**, as a client: retry later, and send `QUIT` when done.

### `421 4.4.2 … Idle too long, closing`

**When**: nothing came from the client for `timeout` seconds (300 by
default). The server hangs up. Before EHLO the reply has no enhanced code.

**Why**: RFC 5321 §4.5.3.2.7 lets a server drop a client that has gone
quiet, so that a dead client does not hold a connection forever. An
`onData` hook that takes longer than `timeout` can run into it too, since
nothing moves on the socket while it runs.

**Fix**, as a client: send `QUIT` when done; a pooled connection that
waits longer must reconnect, or send `NOOP` within the timeout.

**Fix**, as the operator: raise `timeout`, in seconds, and keep `onData`
short: queue the message and answer, then deliver it.

```ts
createSmtpServer({
	// …
	timeout: 600,
});
```
