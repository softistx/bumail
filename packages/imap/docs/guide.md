# Guide

- [Running the server](#running-the-server)
- [Logging in](#logging-in)
- [The session](#the-session)
- [Commands](#commands)
- [How the store appears over IMAP](#how-the-store-appears-over-imap)
- [New mail: IDLE and notify](#new-mail-idle-and-notify)
- [Limits and slow clients](#limits-and-slow-clients)
- [Errors and onError](#errors-and-onerror)
- [Standards](#standards)

## Running the server

`createImapServer(options)` checks the options and returns a server;
`listen({ port, hostname? })` opens it. One server listens once; run two
for 143 and 993.

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

// Later:
server.stop();      // stop accepting; open sessions finish
server.stop(true);  // and close them
```

`tls` is required: LOGIN is refused on a clear connection, so a server
without TLS could log no one in. On 143 the server offers `STARTTLS`; with
`implicitTls` TLS starts with the first byte (RFC 8314).

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
| SELECT | `* 0 RECENT` | `* LIST () "/" INBOX`, and `* OK [CLOSED]` when another mailbox was selected |
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
  `EXPUNGE` each, keeping their ids in the store.
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
| `maxConnections` | 1000 | |
| `maxMessageSize` | 25 MiB | APPEND; at most 4 294 967 295 |
| `maxLiteralSize` | 64 KiB | any other literal |
| `timeout` | 1800 s | idle time before a hang-up; at least 1800 (§5.4) |
| `loginTimeout` | 60 s | a deadline from connecting to logged in |
| `idleInterval` | 10 s | |
| `hookTimeout` | 60 s | |

A command line is at most 64 KiB; past that it is `BAD Command line too
long`, and the rest of the line is skipped. A command holds at most 32
literals; lists and search keys nest at most 32 deep. A literal too large
is refused before its bytes: `{n}` gets a `BAD` (or `NO` for APPEND) and no
continuation; `{n+}`, whose bytes follow at once, gets a `BYE`.

A client that stops reading is not written to without end: the server
waits for the socket to drain past 64 KiB of output, and stops reading
commands meanwhile. A client that connects and never logs in is cut at
`loginTimeout`, however slowly it trickles bytes.

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
`HOOK_TIMEOUT`), an account it named that the store does not have, a store
call that failed.

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
