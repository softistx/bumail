# Guide

- [Running the server](#running-the-server)
- [Logging in](#logging-in)
- [The session](#the-session)
- [Commands](#commands)
- [How the store appears over IMAP](#how-the-store-appears-over-imap)
- [Mailbox names and modified UTF-7](#mailbox-names-and-modified-utf-7)
- [New mail: IDLE and notify](#new-mail-idle-and-notify)
- [Limits and slow clients](#limits-and-slow-clients)
- [Errors and onError](#errors-and-onerror)
- [Standards](#standards)

## Running the server

`createImapServer(options)` checks the options and returns a server;
`listen({ port, hostname? })` opens it, and resolves to the `{ port,
hostname }` it is bound to once the socket is open. `hostname` defaults
to `0.0.0.0`; port `0` asks the system for a free port, which the result
then names. One server listens once; run two for 143 and 993.

```ts
import { createImapServer } from '@bumail/imap';

const server = createImapServer({
	hostname: 'imap.example.com',
	store,                       // any @bumail/store MailStore
	tls: { key, cert },          // required
	authenticate: ({ username, password }) => checkPassword(username, password),
});
await server.listen({ port: 143 });

const implicit = createImapServer({ ...sameOptions, implicitTls: true });
await implicit.listen({ port: 993 });

// A free port, for a test:
const { port } = await createImapServer(sameOptions).listen({ port: 0 });

// Later:
server.connections; // the connections open now
server.stop();      // stop accepting; open sessions finish
server.stop(true);  // and close them
```

`tls` is required: LOGIN is refused on a clear connection, so a server
without TLS could log no one in. `implicitTls` is `false` by default: the
server starts in clear and offers `STARTTLS`, as on 143. With
`implicitTls: true` TLS starts with the first byte (RFC 8314), as on 993.

`server.connections` is the number of connections open at this moment,
logged in or not; `maxConnections` caps it.

## Logging in

`authenticate(credentials, session)` is asked for LOGIN and for
AUTHENTICATE PLAIN, only once TLS is on. It answers the id of the account
in the store to serve, or `null` (or `undefined`) to refuse.

```ts
async authenticate({ mechanism, username, password }, session) {
	const user = await users.find(username);
	if (!user || !(await Bun.password.verify(password, user.hash))) return null;
	session.data.plan = user.plan; // your own state, for onError and later hooks
	return user.accountId;
}
```

- `mechanism` is `LOGIN` or `PLAIN`. A PLAIN authorization identity other
  than the username is refused before the hook is asked.
- A refusal answers `NO [AUTHENTICATIONFAILED] Authentication failed`. The
  third failure on a connection closes it.
- A hook that throws, or does not settle within `hookTimeout` seconds, or
  names an account the store does not have, answers
  `NO [UNAVAILABLE] Temporary authentication failure` and goes to
  `onError`.
- On a clear connection the capabilities say `STARTTLS LOGINDISABLED`,
  with no `AUTH=`; LOGIN and AUTHENTICATE answer
  `NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`
  before reading a password. Once encrypted, `AUTH=PLAIN SASL-IR` is
  offered.

## The session

Each connection is a session, which `authenticate` and `onError` receive
as an `ImapSession`:

| field | |
| --- | --- |
| `id` | a random id of 16 hex characters, drawn for each connection: tie your logs to it |
| `remoteAddress` | the client's IP address |
| `secure` | `true` once TLS is on: from the first byte with `implicitTls`, or after STARTTLS |
| `user` | the username the client logged in with; absent before the login |
| `accountId` | the account `authenticate` answered; absent before the login |
| `data` | an object for your own state; it lasts the whole connection, STARTTLS included |

The fields are read-only: the server sets them, and a hook reads a
snapshot of them. Only `data` is yours to write into.

```ts
authenticate: async ({ username, password }, session) => {
	session.data.since = Date.now();
	return (await check(username, password)) ? accountIdOf(username) : null;
},
onError: (error, session) => {
	logger.error({ error, session: session.id, user: session.user, since: session.data.since });
},
```

A connection goes through the states of RFC 9051 §3: *not authenticated*,
*authenticated* after a login, *selected* after SELECT or EXAMINE, and
*logout*. A command sent in a state it does not belong to is
`BAD NAME is not valid in the <state> state`.

Both IMAP4rev1 and IMAP4rev2 are advertised. A session speaks IMAP4rev1
until the client sends `ENABLE IMAP4rev2`, which changes what it gets:

| | IMAP4rev1 | after `ENABLE IMAP4rev2` |
| --- | --- | --- |
| mailbox names that are not ASCII | modified UTF-7 (`&ZeVnLIqe-`) | UTF-8 |
| SEARCH without RETURN | `* SEARCH 1 2` | `* ESEARCH (TAG "a") ALL 1:2` |
| SELECT | `* 0 RECENT`, and `* OK [UNSEEN n]` naming the first unseen message when there is one (RFC 3501 §6.3.1) | `* LIST () "/" INBOX`, and `* OK [CLOSED]` when another mailbox was selected |
| LSUB and CHECK | answered | answered, though rev2 dropped them |

`ENABLE` names other than `IMAP4rev2` are left off: `ENABLE CONDSTORE`
answers `* ENABLED` without it.

## Commands

| state | commands |
| --- | --- |
| any | CAPABILITY, NOOP, LOGOUT |
| not authenticated | STARTTLS, LOGIN, AUTHENTICATE PLAIN (with an initial response, RFC 4959) |
| authenticated and selected | ENABLE, SELECT, EXAMINE, CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE, LIST, LSUB, STATUS, NAMESPACE, APPEND, IDLE |
| selected | CLOSE, UNSELECT, EXPUNGE, UID EXPUNGE, FETCH, STORE, COPY, MOVE, SEARCH, CHECK, and the UID forms of FETCH, STORE, COPY, MOVE and SEARCH |

What each one takes:

- **LIST** — patterns with `*` and `%`, several in parentheses; the
  selection options `SUBSCRIBED`, `REMOTE`, `RECURSIVEMATCH` and
  `SPECIAL-USE`; `RETURN (SUBSCRIBED CHILDREN SPECIAL-USE STATUS (…))`
  (RFC 5258, 6154, 5819). Every mailbox says `\HasChildren` or
  `\HasNoChildren`, and its special-use attribute. INBOX comes first.
- **STATUS** — `MESSAGES`, `UIDNEXT`, `UIDVALIDITY`, `UNSEEN`, `SIZE`,
  `DELETED`, and `RECENT`, always 0.
- **FETCH** — `FLAGS`, `UID`, `INTERNALDATE`, `RFC822.SIZE`, `ENVELOPE`,
  `BODY`, `BODYSTRUCTURE`, `BODY[section]<partial>` and `BODY.PEEK[…]`,
  the IMAP4rev1 names `RFC822`, `RFC822.HEADER`, `RFC822.TEXT`, and the
  macros `ALL`, `FAST`, `FULL`. A section is a part number (`1.2`),
  `HEADER`, `HEADER.FIELDS (…)`, `HEADER.FIELDS.NOT (…)`, `TEXT` or
  `MIME`. A section the message does not have is `NIL`. `BODY[…]`
  without `.PEEK` sets `\Seen`, and the response then carries `FLAGS`.
- **STORE** — `FLAGS`, `+FLAGS`, `-FLAGS`, each with `.SILENT`.
- **SEARCH** — `ALL`, the flag keys (`SEEN`, `UNSEEN`, `FLAGGED`,
  `KEYWORD`…), `FROM`, `TO`, `CC`, `BCC`, `SUBJECT`, `HEADER`, `BODY`,
  `TEXT`, `BEFORE`, `ON`, `SINCE`, `SENTBEFORE`, `SENTON`, `SENTSINCE`,
  `LARGER`, `SMALLER`, `UID`, a sequence set, `NOT`, `OR` and
  parentheses; `CHARSET UTF-8` or `US-ASCII`; `RETURN (MIN MAX ALL
  COUNT)` (RFC 4731). `BODY` and `TEXT` stream the stored message, without
  case, and do not decode base64 or quoted-printable.
- **APPEND** — one message, with flags and a date, streamed into the
  store as it arrives: `{n}` gets `+ Ready for literal data`, `{n+}` is
  read at once (RFC 7888).
- **MOVE** (RFC 6851) — the messages leave the selected mailbox with an
  `EXPUNGE` each, keeping their ids in the store. A MOVE into the selected
  mailbox itself answers OK and changes nothing: the messages are already
  where they were asked to be, with the same UIDs, and nothing is
  expunged.
- **CLOSE** expunges the `\Deleted` messages without saying so;
  **UNSELECT** (RFC 3691) does not expunge.

A sequence number past the last message is `BAD No such message`
(§6.4.4); a UID set that names nothing answers OK with no data.

## How the store appears over IMAP

| IMAP | `@bumail/store` |
| --- | --- |
| mailbox `Work/2026` | a mailbox named `2026` whose parent is `Work`; the delimiter is `/` |
| `\Sent`, `\Archive`, `\Trash`… | the mailbox `role` |
| UIDVALIDITY, UIDNEXT, UIDs | the mailbox's `uidValidity`, `uidNext`, and each entry's `uid` |
| flags and keywords | the message's `flags`, as the store spells them |
| INTERNALDATE | `receivedAt` |
| the message | the stored blob, read as it streams |
| SUBSCRIBE | `isSubscribed` |

CREATE makes the parents a name needs. DELETE refuses INBOX, a mailbox
that has children, and the selected mailbox. RENAME moves the children with
it; INBOX cannot be renamed.

The selected mailbox is followed through the store's `highestModseq` and
its changes: a message added elsewhere is `* n EXISTS`, one removed is
`* n EXPUNGE`, a flag changed is `* n FETCH (UID u FLAGS (…))`. They are
told at the next command that allows it (NOOP, IDLE, FETCH, STORE,
SEARCH…). If the selected mailbox is deleted, the session is closed with
`* BYE The selected mailbox was deleted, closing`.

## Mailbox names and modified UTF-7

A session speaks IMAP4rev1 until the client sends `ENABLE IMAP4rev2`, and
IMAP4rev1 writes a mailbox name that is not ASCII in modified UTF-7 (RFC
3501 §5.1.3): `Entwürfe` is `Entw&APw-rfe`, and `&` itself is `&-`. The
server decodes what such a client sends and encodes what it answers; the
store always holds the UTF-8 name. A name that does not decode is
`BAD "…" is not a valid modified UTF-7 mailbox name`.

The two functions it uses are exported, for logs, tests or an admin tool
that speaks to the store in the names a client shows:

```ts
import { decodeUtf7, encodeUtf7 } from '@bumail/imap';

encodeUtf7('Entwürfe');     // 'Entw&APw-rfe'
encodeUtf7('R&D');          // 'R&-D'
decodeUtf7('Entw&APw-rfe'); // 'Entwürfe'
decodeUtf7('&Jjo');         // undefined: not modified UTF-7
```

`decodeUtf7` answers `undefined`, never throws, for a name that is not
valid modified UTF-7.

## New mail: IDLE and notify

During IDLE the server looks at the store every `idleInterval` seconds (10
by default). Where the mail is delivered in the same process, wake the
account's sessions at once:

```ts
await store.addMessage(accountId, inboxId, { content });
server.notify(accountId);
```

## Limits and slow clients

| option | default | |
| --- | --- | --- |
| `maxConnections` | 1000 | connections open at once, logged in or not; one more is greeted with `* BYE [UNAVAILABLE] Too many connections, try later` and closed |
| `maxMessageSize` | 25 MiB | APPEND; at most 4 294 967 295 |
| `maxLiteralSize` | 64 KiB | any other literal |
| `timeout` | 1800 s | idle time before a hang-up; at least 1800 (§5.4) |
| `loginTimeout` | 60 s | a deadline from connecting to logged in |
| `idleInterval` | 10 s | seconds between two looks at the store during IDLE; a fraction such as `0.5` is allowed, 0 is not |
| `hookTimeout` | 60 s | seconds `authenticate` has to settle; past it the login answers `NO [UNAVAILABLE] Temporary authentication failure` and `onError` gets an `ImapError` with code `HOOK_TIMEOUT` |

The sizes are bytes, the timers seconds. `maxConnections`, the sizes,
`timeout`, `loginTimeout` and `hookTimeout` are whole numbers above 0;
every timer is at most 2 147 483 seconds, what `setTimeout` can wait.

```ts
createImapServer({
	...options,
	maxConnections: 5000,          // a busy server
	idleInterval: 30,              // look less often, and call notify on delivery
	hookTimeout: 10,               // a password check that should never take long
	maxMessageSize: 50 * 1024 * 1024,
});
```

Some limits are fixed, so that no single command — and nothing a client
that has not logged in sends — costs the server more than a bounded
amount:

| limit | value | past it |
| --- | --- | --- |
| a command line | 64 KiB | `BAD Command line too long`; the rest of the line is skipped |
| literals in one command | 32 | `BAD More than 32 literals in one command` |
| before login: literals in one command | 2 | `BAD More than 2 literals before login` |
| before login: one literal | 1 KiB, as LITERAL- (RFC 7888) | `BAD [TOOBIG] Literal over 1024 bytes before login` |
| lists and search keys nested | 32 deep | `BAD Lists nest too deep`, `BAD Search keys nest too deep` |
| a mailbox name, CREATE and RENAME | 32 levels, 1024 characters | `NO [LIMIT] A mailbox name has at most 32 levels`, `NO [LIMIT] A mailbox name is at most 1024 characters` |
| a LIST pattern, reference included | 1024 characters | `BAD The pattern is too long` |
| patterns in one LIST | 16 | `BAD More than 16 patterns in one LIST` |
| TEXT and BODY keys in one SEARCH | 32 | `BAD More than 32 TEXT or BODY keys in one SEARCH` |
| client text repeated in a response | 100 characters, no control character | cut, `...` marking the cut |

A literal too large is refused before its bytes: `{n}` gets a `BAD` (or
`NO` for APPEND) and no continuation; `{n+}`, whose bytes follow at once,
gets a `BYE`. LIST patterns are matched in one greedy scan, consecutive
wildcards merged, so a pattern of 1024 wildcards costs no more than a
plain name.

A client that stops reading is not written to without end: the server
waits for the socket to drain past 64 KiB of output, and stops reading
commands meanwhile; a message is read and written 64 KiB at a time, so
what waits for such a client is a slice, never the whole message. Nor
does it hold the server for good: `loginTimeout` and `timeout` hang up on
it at once, dropping what it did not read, and any other hang-up (LOGOUT,
a `BYE`) waits at most 5 seconds for the client to read what is left. A
client that connects and never logs in is cut at `loginTimeout`, however
slowly it trickles bytes, and whether it reads or not; its place under
`maxConnections` is free again.

## Errors and onError

Nothing a client sends throws out of the server. A command that breaks the
grammar is `BAD`; one the store refuses is `NO`, with a response code:

| store error | response |
| --- | --- |
| `NOT_FOUND` | `NO [NONEXISTENT] …` |
| `ALREADY_EXISTS` | `NO [ALREADYEXISTS] …` |
| `INVALID` | `NO [CANNOT] …` |
| anything else | `NO [SERVERBUG] Internal error`, and `onError` |

`onError(error, session)` is told of what went wrong in your code or the
store: an `authenticate` that threw or timed out (an `ImapError` with code
`HOOK_TIMEOUT`), an account it named that the store does not have
(`Error: authenticate answered the account "…", which the store does not
have`), a store call that failed, during a command or a look of IDLE. The
client sees only `NO [UNAVAILABLE]` or `NO [SERVERBUG]`, so `onError` is
where you learn why. It is called synchronously and should not throw; if
it does, the error is dropped.

```ts
import { createImapServer, ImapError } from '@bumail/imap';

createImapServer({
	...options,
	onError(error, session) {
		if (error instanceof ImapError && error.code === 'HOOK_TIMEOUT') {
			metrics.increment('imap.auth.timeout');
		}
		console.error(`imap ${session.id} ${session.remoteAddress} ${session.user ?? '-'}`, error);
	},
});
```

Without `onError` these errors are not logged anywhere.

[Troubleshooting](troubleshooting.md) has an entry for each error and
each response, headed by its exact text.

## Standards

| | |
| --- | --- |
| RFC 9051 | IMAP4rev2 |
| RFC 3501 | IMAP4rev1, for clients that do not enable rev2 |
| RFC 2177 | IDLE |
| RFC 2342 | NAMESPACE |
| RFC 3691 | UNSELECT |
| RFC 4315 §2.1 | UID EXPUNGE (UIDPLUS's other parts are not implemented) |
| RFC 4616, 4959 | SASL PLAIN, SASL-IR |
| RFC 4731 | ESEARCH |
| RFC 5161 | ENABLE |
| RFC 5258, 5819 | LIST-EXTENDED, LIST-STATUS |
| RFC 6154 | SPECIAL-USE |
| RFC 6851 | MOVE |
| RFC 7888 | LITERAL+ |
| RFC 7889 | APPENDLIMIT |
| RFC 8314 | implicit TLS |

Not implemented: CONDSTORE and QRESYNC (RFC 7162), UIDPLUS's APPENDUID and
COPYUID, BINARY (RFC 3516), MULTIAPPEND (RFC 3502), SEARCHRES (RFC 5182),
COMPRESS, QUOTA, METADATA, NOTIFY, and `\Recent` (always 0).
