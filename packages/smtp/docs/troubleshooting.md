# Troubleshooting

Each entry is headed by the text you see: the message of the error thrown,
or the reply the server sends, as a client or a log prints it. `…` stands
for the part that varies, often the server's `hostname`.

A reply carries its enhanced status code (`5.7.1`, RFC 3463) only after
`EHLO`. After `HELO`, or before either, the same reply comes without it:
`554 Relay access denied`, not `554 5.7.1 Relay access denied`.

**Configuration**

- [`SmtpError: createSmtpServer(): "…" is not a host name`](#smtperror-createsmtpserver--is-not-a-host-name)
- [`SmtpError: createSmtpServer(): onData must be a function: it is where messages go`](#smtperror-createsmtpserver-ondata-must-be-a-function-it-is-where-messages-go)
- [`SmtpError: createSmtpServer(): implicitTls needs tls: { key, cert }`](#smtperror-createsmtpserver-implicittls-needs-tls--key-cert-)
- [`SmtpError: createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate`](#smtperror-createsmtpserver-submission-takes-mail-only-from-authenticated-users-so-it-needs-authenticate)
- [`SmtpError: createSmtpServer(): authenticate needs tls: { key, cert }, since AUTH is offered only once encrypted`](#smtperror-createsmtpserver-authenticate-needs-tls--key-cert--since-auth-is-offered-only-once-encrypted)
- [`SmtpError: createSmtpServer(): localDomains must be an array of domains or a function`](#smtperror-createsmtpserver-localdomains-must-be-an-array-of-domains-or-a-function)
- [`SmtpError: createSmtpServer(): … must be a positive integer, not …`](#smtperror-createsmtpserver--must-be-a-positive-integer-not-)
- [`SmtpError: listen(): the server is already listening on …`](#smtperror-listen-the-server-is-already-listening-on-)

**Relaying and authentication**

- [`554 5.7.1 Relay access denied`](#554-571-relay-access-denied)
- [`AUTH` is missing from the EHLO reply](#auth-is-missing-from-the-ehlo-reply)
- [`538 5.7.11 Encryption required for requested authentication mechanism`](#538-5711-encryption-required-for-requested-authentication-mechanism)
- [`530 5.7.0 Authentication required`](#530-570-authentication-required)
- [`535 5.7.8 Authentication credentials invalid`](#535-578-authentication-credentials-invalid)
- [`454 4.7.0 Temporary authentication failure`](#454-470-temporary-authentication-failure)
- [`421 4.7.0 … Too many failed authentications, closing`](#421-470--too-many-failed-authentications-closing)
- [`501 5.5.2 Cannot decode the response`](#501-552-cannot-decode-the-response)
- [`504 5.5.4 Unrecognized authentication type`](#504-554-unrecognized-authentication-type)
- [`502 5.5.1 AUTH not available`](#502-551-auth-not-available)

**Commands**

- [`503 Send EHLO first`](#503-send-ehlo-first)
- [`503 5.5.1 Send MAIL first`, `503 5.5.1 Nested MAIL command`](#503-551-send-mail-first-503-551-nested-mail-command)
- [`501 5.5.4 Syntax: …`](#501-554-syntax-)
- [`500 5.5.2 Command unrecognized`](#500-552-command-unrecognized)
- [`454 4.7.0 TLS not available`](#454-470-tls-not-available)
- [`555 5.5.4 … is not supported`](#555-554--is-not-supported)
- [`555 … needs EHLO`](#555--needs-ehlo)
- [`553 5.6.7 A non-ASCII address needs SMTPUTF8`](#553-567-a-non-ascii-address-needs-smtputf8)
- [`500 5.5.6 Line too long`](#500-556-line-too-long)

**Messages**

- [`550 5.6.11 Bare CR or LF is not allowed in a message`](#550-5611-bare-cr-or-lf-is-not-allowed-in-a-message)
- [`552 5.3.4 Message too big for system`](#552-534-message-too-big-for-system)
- [`452 4.5.3 Too many recipients`](#452-453-too-many-recipients)
- [`554 5.5.1 No valid recipients`](#554-551-no-valid-recipients)
- [`SmtpError: The message …; do not deliver it`, from `message.content`](#smtperror-the-message--do-not-deliver-it-from-messagecontent)

**Hooks**

- [`451 4.3.0 Local error in processing`](#451-430-local-error-in-processing)
- [`SmtpError: … did not settle within hookTimeout (… s)`, in `onError`](#smtperror--did-not-settle-within-hooktimeout--s-in-onerror)
- [`SmtpError: … answered …, which is not a refusal`, in `onError`](#smtperror--answered--which-is-not-a-refusal-in-onerror)
- [`421 4.3.0 Local error, closing`](#421-430-local-error-closing)

**Connections**

- [`421 4.7.0 … Too many errors, closing`](#421-470--too-many-errors-closing)
- [`421 4.3.2 … Too many connections, try later`](#421-432--too-many-connections-try-later)
- [`421 4.4.2 … Idle too long, closing`](#421-442--idle-too-long-closing)
- [`554 … Talked before the greeting`](#554--talked-before-the-greeting)

## Configuration

Each of these is thrown by `createSmtpServer(options)` itself, before
anything listens, as an `SmtpError` with `code: 'INVALID_OPTION'`:

```ts
import { SmtpError, createSmtpServer } from '@bumail/smtp';

try {
	createSmtpServer(options);
} catch (error) {
	if (error instanceof SmtpError && error.code === 'INVALID_OPTION') console.error(error.message);
	throw error;
}
```

### `SmtpError: createSmtpServer(): "…" is not a host name`

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
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
});
await server.listen({ port: 25, hostname: '0.0.0.0' });
```

### `SmtpError: createSmtpServer(): onData must be a function: it is where messages go`

**When**: no `onData`, or one that is not a function.

**Why**: an SMTP server that answers `250` has taken responsibility for the
message. Without `onData` it would have nowhere to put it.

**Fix**: give `onData`, and read the message to its end:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
});
```

### `SmtpError: createSmtpServer(): implicitTls needs tls: { key, cert }`

**When**: `implicitTls: true` without `tls`.

**Why**: implicit TLS (port 465, RFC 8314) starts TLS on the first byte,
so it needs a key and a certificate.

**Fix**:

```ts
import { createSmtpServer } from '@bumail/smtp';

const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	implicitTls: true,
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	async authenticate({ username, password }) {
		const hash = users.get(username);
		return hash !== undefined && (await Bun.password.verify(password, hash));
	},
	localDomains: ['example.com'],
	async onData(message) {
		await Bun.write(`queue/${message.id}.eml`, await new Response(message.content).bytes());
	},
});
```

Leave `implicitTls` out on port 25 or 587: `tls` alone offers STARTTLS.

### `SmtpError: createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate`

**When**: `mode: 'submission'` without `authenticate`.

**Why**: a submission server refuses `MAIL FROM` until the client has
authenticated. With nothing to check credentials, it could take no mail at
all.

**Fix**: give `authenticate`, and `tls` with it: AUTH is offered only over
TLS, so a submission server without `tls` takes no mail either. See the
snippet above. For mail from the Internet to your own domains, use
`mode: 'mx'` (the default) instead.

### `SmtpError: createSmtpServer(): authenticate needs tls: { key, cert }, since AUTH is offered only once encrypted`

**When**: `authenticate` without `tls`.

**Why**: the server offers AUTH only over TLS, so a password never crosses
the network in clear. Without `tls`, no session could ever be encrypted,
and `authenticate` would never be called.

**Fix**: give `tls` with `authenticate`, as in the snippet above; or drop
`authenticate` if the server is an MX that takes no AUTH.

### `SmtpError: createSmtpServer(): localDomains must be an array of domains or a function`

**When**: `localDomains` is missing, a single string (`'example.com'`), or
an array holding something other than strings.

**Why**: `localDomains` decides which recipients an unauthenticated
session may send to; the server never guesses it.

**Fix**: an array, even for one domain, or a function:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'], // not 'example.com'
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

### `SmtpError: createSmtpServer(): … must be a positive integer, not …`

**When**: `maxMessageSize`, `maxRecipients`, `maxConnections`, `maxErrors`,
`timeout` or `hookTimeout` is `0`, negative, a fraction, `NaN` or
`Infinity`.

**Why**: each is a bound on what a client can make the server do, and none
can be switched off.

**Fix**: pass integers, or leave an option out for its default:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	maxMessageSize: 50 * 1024 * 1024, // bytes; default 25 MiB
	maxRecipients: 500, // default 100
	maxConnections: 2000, // default 1000
	maxErrors: 20, // default 10
	timeout: 600, // seconds, not milliseconds; default 300
	hookTimeout: 30, // seconds; default 60
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

`timeout` and `hookTimeout` are in seconds: `300_000` is accepted, and
means 83 hours.

### `SmtpError: listen(): the server is already listening on …`

**When**: `listen` on a server that is already listening. Its `code` is
`ALREADY_LISTENING`.

**Why**: a server holds one listener; a second would leave the first
unreachable by `stop`.

**Fix**: create one server per port, with the same options:

```ts
import { createSmtpServer, type SmtpServerOptions } from '@bumail/smtp';

const options = {
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
} satisfies SmtpServerOptions;

await createSmtpServer(options).listen({ port: 25 });
await createSmtpServer(options).listen({ port: 2525 });
```

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
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: (domain) =>
		domain === 'example.com' || domain.endsWith('.example.com'),
	onData: async (message) => {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
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

- the server was given `authenticate` (otherwise
  [`502 5.5.1 AUTH not available`](#502-551-auth-not-available));
- the connection is encrypted: `implicitTls`, or after `STARTTLS`. On port
  25 or 587, the EHLO sent before STARTTLS never lists AUTH;
- the session has not authenticated yet.

Without `tls`, the server offers no `STARTTLS` either, and `STARTTLS` gets
`454 4.7.0 TLS not available`; and since `authenticate` needs `tls`, such a
server never offers AUTH.

**Fix**, as the operator: give both `tls` and `authenticate` (the server
refuses `authenticate` without `tls` at creation):

```ts
import { createSmtpServer } from '@bumail/smtp';

const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	async authenticate({ username, password }) {
		const hash = users.get(username);
		return hash !== undefined && (await Bun.password.verify(password, hash));
	},
	localDomains: ['example.com'],
	async onData(message) {
		await Bun.write(`queue/${message.id}.eml`, await new Response(message.content).bytes());
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
anything but `true`; or `AUTH PLAIN` with an authorization identity other
than the username, refused before `authenticate` is asked. Each one counts
toward `maxErrors`, and the third in a session
[closes it](#421-470--too-many-failed-authentications-closing).

**Why**: the server accepts the credentials only when `authenticate`
returns, or resolves to, exactly `true`. A user object, a non-empty string
or `1` counts as a refusal.

**Fix**, as the operator: return a boolean:

```ts
import { createSmtpServer } from '@bumail/smtp';

const users = new Map([['alice', await Bun.password.hash('correct horse')]]);

createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	async authenticate({ username, password }) {
		const hash = users.get(username);
		return hash !== undefined && (await Bun.password.verify(password, hash)); // a boolean
	},
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

A session acts as the user it authenticated as: there is no option to let
one user act as another through PLAIN's authorization identity.

**Fix**, as a client: check the username and password, and send no
authorization identity — or the username itself.

### `454 4.7.0 Temporary authentication failure`

**When**: `AUTH`, when `authenticate` threw, its promise rejected, or it
did not settle within `hookTimeout`. It does not count as a failed attempt,
nor toward `maxErrors`.

**Why**: an error in the check is the server's failure, not the client's
(RFC 4954 §6), so the client is told to try again later. The error goes to
`onError`.

**Fix**, as the operator: log in `onError` to see why, then fix the store
`authenticate` reads:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'smtp.example.com',
	mode: 'submission',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/smtp.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/smtp.example.com.crt').text(),
	},
	authenticate: async ({ username, password }) => {
		const response = await fetch('https://directory.example.com/check', {
			method: 'POST',
			body: JSON.stringify({ username, password }),
		});
		return response.ok;
	},
	onError: (error, session) => console.error(`[${session.id}]`, error),
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

**Fix**, as a client: retry later.

### `421 4.7.0 … Too many failed authentications, closing`

**When**: the third `535 5.7.8` in one session. The server hangs up. `…`
is the server's `hostname`.

**Why**: it bounds password guessing on one connection. The limit is
three, and is not an option. A response that is not valid base64 gets
`501 5.5.2 Cannot decode the response` and does not count.

**Fix**, as a client: fix the credentials, then connect again.

**Fix**, as the operator: see
[`535 5.7.8`](#535-578-authentication-credentials-invalid): a check that
never answers `true` refuses everyone.

### `501 5.5.2 Cannot decode the response`

**When**: the response to `AUTH`, or to its `334` challenge, is not valid
base64, not UTF-8, or (for PLAIN) not `authzid NUL user NUL password` with
a username and a password. It counts toward `maxErrors`, not toward the
three AUTH attempts.

**Why**: the server reads only what RFC 4954 and RFC 4616 define.

**Fix**, as a client: base64-encode the whole response, NULs included:

```ts
const response = new TextEncoder().encode('\0alice\0correct horse').toBase64();
// AUTH PLAIN AGFsaWNlAGNvcnJlY3QgaG9yc2U=
```

A client answering a challenge with `*` cancels instead, and gets
`501 5.0.0 Authentication cancelled`.

### `504 5.5.4 Unrecognized authentication type`

**When**: `AUTH` with a mechanism other than `PLAIN` and `LOGIN`, such as
`CRAM-MD5`, `SCRAM-SHA-256` or `XOAUTH2`.

**Why**: the server implements PLAIN and LOGIN only, over TLS.

**Fix**, as a client: pick `PLAIN` or `LOGIN`, as the EHLO reply's
`AUTH PLAIN LOGIN` line lists.

### `502 5.5.1 AUTH not available`

**When**: `AUTH` on a server created without `authenticate`.

**Why**: such a server has no way to check credentials, and never offers
AUTH. An MX usually has none.

**Fix**, as a client: send to the submission server, not to the MX.
**Fix**, as the operator: give `authenticate` and `tls`; see
[`AUTH` is missing from the EHLO reply](#auth-is-missing-from-the-ehlo-reply).

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

The same lack of EHLO turns a bad `EHLO` or `HELO` argument into
`501 Syntax: EHLO hostname`, also without an enhanced code: give a domain
or an address literal such as `[192.0.2.1]`.

### `503 5.5.1 Send MAIL first`, `503 5.5.1 Nested MAIL command`

**When**: `RCPT TO` or `DATA` before a `MAIL FROM` was accepted; or a
second `MAIL FROM` while a transaction is open. Each counts toward
`maxErrors`.

**Why**: RFC 5321 §4.1.4 orders a transaction: one MAIL, one or more RCPT,
then DATA. A `MAIL FROM` refused by the server or by `onMailFrom` opens no
transaction, so the RCPT after it gets this reply.

**Fix**, as a client: read the reply to `MAIL FROM` before sending RCPT;
send `RSET` to start a transaction over.

### `501 5.5.4 Syntax: …`

**When**: a command whose argument is wrong: `MAIL FROM:<address>` without
the angle brackets or the colon, a path with a space, a control or an
invisible character (C1, zero-width, bidi, U+2028), `DATA` or `STARTTLS`
with an argument, `AUTH` with more than a mechanism and a response,
`SIZE=` that is not a number. The text after `Syntax:` gives the expected
form. Each counts toward `maxErrors`.

**Why**: the server reads RFC 5321's grammar exactly, so that an address is
never read two ways.

**Fix**, as a client: send the form the reply gives:

```text
C: MAIL FROM:<alice@example.com> SIZE=1024
S: 250 2.1.0 OK
```

### `500 5.5.2 Command unrecognized`

**When**: a verb the server does not implement — `EXPN`, `BDAT`, `TURN`,
`ETRN`, or a typo. It counts toward `maxErrors`.

**Why**: the server implements RFC 5321's commands and the extensions its
EHLO lists. `EXPN` gives away a list's members; `BDAT` is CHUNKING, not
offered.

**Fix**, as a client: use only what the EHLO reply announces; send `DATA`
rather than `BDAT`.

### `454 4.7.0 TLS not available`

**When**: `STARTTLS` on a server created without `tls`.

**Why**: with no key and certificate, the server cannot encrypt; it does
not list `STARTTLS` in its EHLO reply either.

**Fix**, as the operator: give `tls` (and `STARTTLS` with an argument gets
`501 5.5.4 Syntax: STARTTLS`; an encrypted session, `503 5.5.1 TLS already
active`):

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	tls: {
		key: await Bun.file('/etc/ssl/mx.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/mx.example.com.crt').text(),
	},
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

**Fix**, as a client: send in clear, or to a server that offers TLS.

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

**When**: during `DATA`, as soon as the message holds a CR or an LF that is
not part of a CRLF pair. `message.content` errors with an `SmtpError` of
code `BARE_LINE_BREAK`, so `onData` never reads it to a clean end; the rest
of the message is read and dropped, and the session goes on.

**Why**: a bare line break is how SMTP smuggling hides a second message
inside the first: servers that read line ends differently disagree where
the message ends. The server refuses such a message rather than guess.

**Fix**, as a client: send every line ending as CRLF, headers and body,
and encode binary content (base64 or quoted-printable). There is no
option to accept it.

### `552 5.3.4 Message too big for system`

**When**:

- `MAIL FROM:<…> SIZE=n` with `n` above `maxMessageSize`: refused at once;
- during `DATA`, once the message is larger than `maxMessageSize`.
  `message.content` errors with an `SmtpError` of code `MESSAGE_TOO_BIG`;
  the rest of the message is read and dropped, and the session goes on.

**Why**: `maxMessageSize` (25 MiB by default) bounds what one message can
cost. The EHLO reply announces it as `SIZE n`. The size is counted after
dot-unstuffing, without the server's own `Received` field.

**Fix**, as the operator: raise the limit:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	maxMessageSize: 50 * 1024 * 1024,
	onData: async (message) => {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
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

### `554 5.5.1 No valid recipients`

**When**: `DATA` with no recipient accepted. Whatever the client pipelined
behind `DATA` in the same write — the message itself, usually — is dropped,
never read as commands.

**Why**: there is no one to deliver to: each `RCPT TO` was refused (relay,
`onRcptTo`, syntax) or none was sent.

**Fix**, as a client: read the replies to `RCPT TO`; send `DATA` only once
one was `250`.

### `SmtpError: The message …; do not deliver it`, from `message.content`

**When**: `onData` reads `message.content` and the read throws an
`SmtpError` whose `code` is one of:

| `code` | Message | The client gets |
| --- | --- | --- |
| `MESSAGE_TOO_BIG` | `The message is larger than maxMessageSize (… bytes); do not deliver it` | `552 5.3.4` |
| `BARE_LINE_BREAK` | `The message holds a bare CR or LF (SMTP smuggling); do not deliver it` | `550 5.6.11` |
| `CONNECTION_LOST` | `The client disconnected before the end of the message; do not deliver it` | nothing: it is gone |
| `HOOK_TIMEOUT` | `onData did not read the message within hookTimeout (… s); do not deliver it` | `451 4.3.0` |

**Why**: the server hands the message over while it arrives, so it can
only say at the end whether the message may be kept. The stream's error is
that answer; the client is refused whatever `onData` returns.

**Fix**: let the error propagate out of `onData`, and remove whatever you
wrote before it:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	async onData(message) {
		const path = `spool/${message.id}.eml`;
		try {
			await Bun.write(path, new Response(message.content));
		} catch (error) {
			await Bun.file(path).delete().catch(() => undefined);
			throw error;
		}
	},
});
```

## Hooks

### `451 4.3.0 Local error in processing`

**When**: one of the hooks threw, its promise rejected, it did not settle
within `hookTimeout`, or it answered a reply under 400; `localDomains`
threw or did not settle; or `onData` stopped reading the message for
`hookTimeout` seconds:

- `onConnect`: the connection gets `451 Local error in processing` in place
  of its greeting, without an enhanced code, and is closed;
- `onMailFrom`, `onRcptTo`, `localDomains`: that command is refused, and
  the session goes on;
- `onData`: the message is refused, and the client keeps it.

**Why**: a hook that fails has neither accepted nor refused, so the server
answers with a temporary failure: a client tries again later rather than
lose the message. The cause goes to `onError`.

**Fix**, as the operator: log in `onError`, then fix the hook:

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onData: async (message) => {
		await Bun.write(`spool/${message.id}.eml`, await new Response(message.content).bytes());
	},
	onError: (error, session) => console.error(`[${session.id}]`, error),
});
```

**Fix**, as a client: retry later. An MTA queues the message and does so on
its own.

### `SmtpError: … did not settle within hookTimeout (… s)`, in `onError`

**When**: `onError` gets an `SmtpError` of code `HOOK_TIMEOUT`: a hook,
`authenticate` or `localDomains` did not settle within `hookTimeout`
seconds (60 by default), or `onData` stopped reading the message for that
long. The client got `451 4.3.0` (or `454 4.7.0` for `authenticate`).

**Why**: while a hook runs, the session waits; a hook that never settles
would hold the connection, and the message, forever.

**Fix**: put a deadline on what the hook awaits, shorter than
`hookTimeout`, or raise `hookTimeout`:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	hookTimeout: 120,
	onRcptTo: async (path) => {
		const response = await fetch(`https://directory.example.com/${encodeURIComponent(path.local)}`, {
			signal: AbortSignal.timeout(10_000), // throws first: 451, and onError gets the AbortError
		});
		return response.ok ? undefined : reply(550, '5.1.1', 'No such user here');
	},
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

### `SmtpError: … answered …, which is not a refusal`, in `onError`

**When**: `onError` gets an `SmtpError` of code `INVALID_HOOK_REPLY`: a
hook returned something other than `undefined` or a `Reply` with a code
from 400 to 599 — a `250`, a string, a number. The client got `451 4.3.0`.

**Why**: a hook accepts by returning nothing. Sending a `250` from a hook
would tell the client yes while the server did not take the command.

**Fix**: return `undefined` to accept, `reply(4xx|5xx, …)` to refuse:

```ts
import { createSmtpServer, reply } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	onMailFrom: (path) =>
		path.domain === 'spam.example' ? reply(550, '5.7.1', 'Sender refused') : undefined,
	onData: async (message) => {
		await new Response(message.content).bytes();
	},
});
```

### `421 4.3.0 Local error, closing`

**When**: during a session, then the server hangs up. The reply carries
no enhanced code before EHLO.

**Why**: the server failed while handling a command, outside any hook:
a bug in this package. `onError` gets the error.

**Fix**: report it at
[the issue tracker](https://github.com/softistx/bumail/issues), with the
error, the session transcript and the `@bumail/smtp` and Bun versions.

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
quiet, so that a dead client does not hold a connection forever. The time
counts from the client's last byte, so a slow hook can run into it too —
keep `hookTimeout` below `timeout`.

**Fix**, as a client: send `QUIT` when done; a pooled connection that
waits longer must reconnect, or send `NOOP` within the timeout.

**Fix**, as the operator: raise `timeout`, in seconds, and keep `onData`
short: queue the message and answer, then deliver it.

```ts
import { createSmtpServer } from '@bumail/smtp';

createSmtpServer({
	hostname: 'mx.example.com',
	localDomains: ['example.com'],
	timeout: 600,
	onData: async (message) => {
		await Bun.write(`queue/${message.id}.eml`, await new Response(message.content).bytes());
	},
});
```

### `554 … Talked before the greeting`

**When**: on connecting, in place of the greeting, when the client sent
anything before the server's `220`. `…` is the server's `hostname`. The
server hangs up; nothing the client sent is run.

**Why**: RFC 5321 §4.3.1: a client waits for the greeting. Spam engines
that blast a whole transaction at once do not, and are cut off here.

**Fix**, as a client: wait for the `220` before `EHLO`. Every MTA and
client library does; a hand-written client or a test script may not.
