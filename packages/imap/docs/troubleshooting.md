# Troubleshooting

Each entry is headed by the text you see: the message of the error thrown,
or the response the server sends, as a client log or a protocol trace
prints it. `…` stands for the part that varies. A tagged response starts
with the client's tag (`a1 NO …`); it is left out here.

**Configuration**

- [`ImapError: createImapServer(): "…" is not a host name`](#imaperror-createimapserver--is-not-a-host-name)
- [`ImapError: createImapServer(): store must be a MailStore, such as new MemoryMailStore()`](#imaperror-createimapserver-store-must-be-a-mailstore-such-as-new-memorymailstore)
- [`ImapError: createImapServer(): authenticate must be a function: it is how users log in`](#imaperror-createimapserver-authenticate-must-be-a-function-it-is-how-users-log-in)
- [`ImapError: createImapServer(): tls: { key, cert } is required, since LOGIN is offered only once encrypted`](#imaperror-createimapserver-tls--key-cert--is-required-since-login-is-offered-only-once-encrypted)
- [`ImapError: createImapServer(): … must be a positive integer, not …`](#imaperror-createimapserver--must-be-a-positive-integer-not-)
- [`ImapError: createImapServer(): … must be at most …, not …`](#imaperror-createimapserver--must-be-at-most--not-)
- [`ImapError: createImapServer(): timeout must be at least 1800 seconds (RFC 9051 §5.4), not …`](#imaperror-createimapserver-timeout-must-be-at-least-1800-seconds-rfc-9051-54-not-)
- [`ImapError: createImapServer(): idleInterval must be a number of seconds, more than 0 and at most 2147483, not …`](#imaperror-createimapserver-idleinterval-must-be-a-number-of-seconds-more-than-0-and-at-most-2147483-not-)
- [`ImapError: listen(): the server is already listening on …`](#imaperror-listen-the-server-is-already-listening-on-)
- [`ImapError: authenticate did not settle within hookTimeout (… s)`](#imaperror-authenticate-did-not-settle-within-hooktimeout--s)

**Logging in**

- [`NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`](#no-privacyrequired-log-in-only-once-tls-is-on-starttls-first)
- [`NO [AUTHENTICATIONFAILED] Authentication failed`](#no-authenticationfailed-authentication-failed)
- [`NO [UNAVAILABLE] Temporary authentication failure`](#no-unavailable-temporary-authentication-failure)
- [`* BYE Too many failed logins, closing`](#-bye-too-many-failed-logins-closing)
- [`* BYE Too slow to log in, closing`](#-bye-too-slow-to-log-in-closing)
- [`NO [CANNOT] … is not supported: use PLAIN`](#no-cannot--is-not-supported-use-plain)
- [`BAD Cannot decode the PLAIN response`](#bad-cannot-decode-the-plain-response)
- [`BAD TLS is already on`](#bad-tls-is-already-on)

**Connections**

- [`* BYE [UNAVAILABLE] Too many connections, try later`](#-bye-unavailable-too-many-connections-try-later)
- [`* BYE Idle for too long, closing`](#-bye-idle-for-too-long-closing)
- [`* BYE The selected mailbox was deleted, closing`](#-bye-the-selected-mailbox-was-deleted-closing)

**Commands**

- [`BAD … is not valid in the … state`](#bad--is-not-valid-in-the--state)
- [`BAD Unknown command …`](#bad-unknown-command-)
- [`BAD No such message`](#bad-no-such-message)
- [`BAD Command line too long`](#bad-command-line-too-long)
- [`BAD [TOOBIG] Literal over … bytes`](#bad-toobig-literal-over--bytes)
- [`NO [TOOBIG] The message is over … bytes`](#no-toobig-the-message-is-over--bytes)
- [`BAD More than 32 literals in one command`](#bad-more-than-32-literals-in-one-command)
- [`BAD Lists nest too deep` and `BAD Search keys nest too deep`](#bad-lists-nest-too-deep-and-bad-search-keys-nest-too-deep)
- [`BAD MULTIAPPEND is not supported`](#bad-multiappend-is-not-supported)
- [`BAD Unexpected text after the message`](#bad-unexpected-text-after-the-message)
- [`BAD FETCH modifiers are not supported`, `BAD STORE modifiers are not supported`](#bad-fetch-modifiers-are-not-supported-bad-store-modifiers-are-not-supported)
- [`BAD BINARY is not supported yet`](#bad-binary-is-not-supported-yet)
- [`BAD $ (SEARCHRES) is not supported`](#bad--searchres-is-not-supported)
- [`NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset`](#no-badcharset-utf-8-us-ascii-unsupported-charset)
- [`NO [NONEXISTENT] No such mailbox`](#no-nonexistent-no-such-mailbox)
- [`NO [TRYCREATE] No such mailbox`](#no-trycreate-no-such-mailbox)
- [`NO [ALREADYEXISTS] The mailbox already exists`](#no-alreadyexists-the-mailbox-already-exists)
- [`NO [CANNOT] INBOX cannot be deleted`](#no-cannot-inbox-cannot-be-deleted)
- [`NO [CANNOT] Delete the mailboxes inside it first`](#no-cannot-delete-the-mailboxes-inside-it-first)
- [`NO [INUSE] The mailbox is selected: close it first`](#no-inuse-the-mailbox-is-selected-close-it-first)
- [`NO [CANNOT] Renaming INBOX is not supported`](#no-cannot-renaming-inbox-is-not-supported)
- [`NO [CANNOT] A mailbox cannot move inside itself`](#no-cannot-a-mailbox-cannot-move-inside-itself)
- [`NO [CANNOT] The messages are already in this mailbox`](#no-cannot-the-messages-are-already-in-this-mailbox)
- [`NO [READ-ONLY] The mailbox is read-only`](#no-read-only-the-mailbox-is-read-only)
- [`NO [CANNOT] "…" is not a flag a store keeps`](#no-cannot--is-not-a-flag-a-store-keeps)
- [`NO [SERVERBUG] Internal error`](#no-serverbug-internal-error)

**Traps**

- [A client says the server does not support CONDSTORE](#a-client-says-the-server-does-not-support-condstore)
- [New mail shows up seconds late](#new-mail-shows-up-seconds-late)

---

## `ImapError: createImapServer(): "…" is not a host name`

`hostname` is the name the greeting announces: letters, digits, dots and
dashes, such as `imap.example.com`. An address, a URL or a name with a
space is refused.

```ts
createImapServer({ hostname: 'imap.example.com', … });
```

## `ImapError: createImapServer(): store must be a MailStore, such as new MemoryMailStore()`

`store` is where the mail is: an object with the `MailStore` methods of
`@bumail/store`. Pass the store itself, not a promise of it.

```ts
import { MemoryMailStore } from '@bumail/store';
createImapServer({ store: new MemoryMailStore(), … });
```

## `ImapError: createImapServer(): authenticate must be a function: it is how users log in`

Without `authenticate` no one could log in. It answers the account id to
serve, or `null`:

```ts
authenticate: async ({ username, password }) =>
	(await check(username, password)) ? accountIdOf(username) : null,
```

## `ImapError: createImapServer(): tls: { key, cert } is required, since LOGIN is offered only once encrypted`

LOGIN and AUTHENTICATE are refused on a clear connection, so a server
without TLS would log no one in. Give it a key and a certificate, both
non-empty:

```ts
tls: {
	key: await Bun.file('/etc/ssl/imap.example.com.key').text(),
	cert: await Bun.file('/etc/ssl/imap.example.com.crt').text(),
},
```

For a local try, a self-signed certificate for `localhost` does; the
client asks you to accept it.

## `ImapError: createImapServer(): … must be a positive integer, not …`

`maxConnections`, `maxMessageSize`, `maxLiteralSize`, `timeout`,
`loginTimeout` and `hookTimeout` are whole numbers above 0. Seconds for the
timers, bytes for the sizes.

## `ImapError: createImapServer(): … must be at most …, not …`

A timer is at most 2 147 483 seconds: past 2^31 − 1 milliseconds,
`setTimeout` fires after one millisecond, and every client would be cut at
once. `maxMessageSize` is at most 4 294 967 295, the largest literal IMAP
can announce.

## `ImapError: createImapServer(): timeout must be at least 1800 seconds (RFC 9051 §5.4), not …`

RFC 9051 §5.4 says a server's inactivity timer is at least 30 minutes:
clients count on it between two NOOPs. Use 1800 or more; to cut clients
that never log in, set `loginTimeout` instead.

## `ImapError: createImapServer(): idleInterval must be a number of seconds, more than 0 and at most 2147483, not …`

`idleInterval` is how often an IDLE session looks at the store. It may be
a fraction (`0.5`), but not 0. To have new mail arrive at once, call
`server.notify(accountId)` rather than polling faster.

## `ImapError: listen(): the server is already listening on …`

A server listens once. For 143 and 993, create two servers from the same
options, the second with `implicitTls: true`.

## `ImapError: authenticate did not settle within hookTimeout (… s)`

`onError` gets this when `authenticate` neither resolved nor rejected in
`hookTimeout` seconds (60 by default); the client got
`NO [UNAVAILABLE] Temporary authentication failure`. Look for a lookup
with no timeout of its own, or raise `hookTimeout`.

## `NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`

The client sent LOGIN or AUTHENTICATE on a clear connection. The server
advertises `LOGINDISABLED` there, and does not read the password. Set the
client to *STARTTLS* on 143, or *SSL/TLS* on 993.

## `NO [AUTHENTICATIONFAILED] Authentication failed`

`authenticate` answered `null` or `undefined`, or AUTHENTICATE PLAIN
carried an authorization identity other than the username. Check what the
hook received: `username` is what the client typed, often the whole
address.

## `NO [UNAVAILABLE] Temporary authentication failure`

`authenticate` threw, timed out, or answered an account id the store does
not have. `onError` has the error. Make sure the hook returns the store's
account `id`, not the address.

## `* BYE Too many failed logins, closing`

Three failed logins on one connection close it. The client reconnects and
tries again; a wrong saved password does this at every start.

## `* BYE Too slow to log in, closing`

The client did not log in within `loginTimeout` seconds (60) of
connecting. It is a deadline, not an idle timer: bytes sent meanwhile do
not extend it.

## `NO [CANNOT] … is not supported: use PLAIN`

Only AUTHENTICATE PLAIN is offered (`AUTH=PLAIN`). Set the client to
*Normal password*.

## `BAD Cannot decode the PLAIN response`

The PLAIN response was not base64 of `authzid NUL username NUL password`.

## `BAD TLS is already on`

STARTTLS on a connection that is already encrypted: implicit TLS on 993,
or a second STARTTLS.

## `* BYE [UNAVAILABLE] Too many connections, try later`

`maxConnections` (1000) are open. Raise it, or look for a client that
opens a connection per folder without closing them.

## `* BYE Idle for too long, closing`

Nothing came from the client for `timeout` seconds (1800). Clients send
NOOP or restart IDLE before that.

## `* BYE The selected mailbox was deleted, closing`

Another session, or your app, deleted the mailbox this session had
selected. The client reconnects and lists the mailboxes again.

## `BAD … is not valid in the … state`

The command does not belong to the session's state: FETCH before SELECT,
SELECT before logging in, LOGIN after it.

## `BAD Unknown command …`

The command is not one this server implements; the
[guide](guide.md#commands) lists them. `UID` goes only before FETCH,
STORE, COPY, MOVE, SEARCH and EXPUNGE.

## `BAD No such message`

A sequence number past the last message of the mailbox (RFC 9051 §6.4.4).
The client's view is stale: a NOOP brings it up to date.

## `BAD Command line too long`

A line over 64 KiB. Long values go as literals; a client that builds huge
sequence sets can send ranges (`1:500`) instead. A line too long that
announced a `{n+}` literal closes the connection instead
(`* BYE Command line too long, closing`), since its bytes would be read
as commands.

## `BAD [TOOBIG] Literal over … bytes`

A literal of a command other than APPEND over `maxLiteralSize` (64 KiB).
The server answers before the bytes are sent. For `{n+}`, whose bytes
follow at once, it closes the connection instead:
`* BYE [TOOBIG] Literal over … bytes, closing`.

## `NO [TOOBIG] The message is over … bytes`

APPEND of a message over `maxMessageSize` (25 MiB), announced as
`APPENDLIMIT`. Raise the option if your store takes larger messages.

## `BAD More than 32 literals in one command`

No command this server implements needs more.

## `BAD Lists nest too deep` and `BAD Search keys nest too deep`

Parentheses, or `NOT` and `OR`, nested more than 32 deep.

## `BAD MULTIAPPEND is not supported`

APPEND takes one message (RFC 3502's MULTIAPPEND is not implemented). With
`{n+}`, the connection is closed, since the next message's bytes follow.

## `BAD Unexpected text after the message`

Something other than the end of the line followed APPEND's message. The
message is not stored.

## `BAD FETCH modifiers are not supported`, `BAD STORE modifiers are not supported`

`(CHANGEDSINCE …)` and `(UNCHANGEDSINCE …)` are CONDSTORE's, not
implemented yet.

## `BAD BINARY is not supported yet`

`BINARY[…]` (RFC 3516) is not implemented; `BODY[…]` gives the same part,
still encoded.

## `BAD $ (SEARCHRES) is not supported`

`$`, the saved search result of RFC 5182, is not implemented.

## `NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset`

SEARCH CHARSET other than UTF-8 or US-ASCII.

## `NO [NONEXISTENT] No such mailbox`

SELECT, EXAMINE, STATUS, DELETE, RENAME or SUBSCRIBE of a name the
account does not have. Names are case-sensitive, except INBOX.

## `NO [TRYCREATE] No such mailbox`

COPY, MOVE or APPEND to a mailbox that does not exist. The client may
CREATE it and try again.

## `NO [ALREADYEXISTS] The mailbox already exists`

CREATE of an existing name; `NO [ALREADYEXISTS] The new name is taken` is
RENAME's.

## `NO [CANNOT] INBOX cannot be deleted`

INBOX is where new mail goes; it stays.

## `NO [CANNOT] Delete the mailboxes inside it first`

DELETE of a mailbox with children. The store does not keep a mailbox that
only holds others (`\Noselect`), so the children go first.

## `NO [INUSE] The mailbox is selected: close it first`

DELETE of the mailbox this session has selected. CLOSE or UNSELECT, then
DELETE.

## `NO [CANNOT] Renaming INBOX is not supported`

RFC 9051 has RENAME INBOX move its messages to a new mailbox; that is not
implemented. Create the mailbox and MOVE the messages.

## `NO [CANNOT] A mailbox cannot move inside itself`

RENAME of `a` to `a/b`.

## `NO [CANNOT] The messages are already in this mailbox`

MOVE to the selected mailbox. COPY does that.

## `NO [READ-ONLY] The mailbox is read-only`

STORE, EXPUNGE or MOVE after EXAMINE. SELECT the mailbox instead.

## `NO [CANNOT] "…" is not a flag a store keeps`

The store refused a flag: `\Recent`, or a keyword with characters IMAP
does not allow. The text is the store's.

## `NO [SERVERBUG] Internal error`

A store call failed in an unexpected way. `onError` has the error and the
session.

## A client says the server does not support CONDSTORE

It does not yet; the [roadmap](roadmap.md) has it. Clients fall back to
fetching flags, which costs more on large mailboxes.

## New mail shows up seconds late

IDLE looks at the store every `idleInterval` seconds (10). Call
`server.notify(accountId)` after delivering, or lower `idleInterval`.
