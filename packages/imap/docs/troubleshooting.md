# Troubleshooting

Each entry is headed by the text you see: the message of the error thrown,
or the response the server sends, as a client log or a protocol trace
prints it. `…` stands for the part that varies. A tagged response starts
with the client's tag (`a1 NO …`); it is left out here. Search this page
for the text, then follow the link: the entries are split by topic.

Where a response repeats the client's own text — a mailbox name, a date,
an unknown command or item — that text is cut after 100 characters
(`...` marks the cut) and its control characters are left out, so a CR or
LF sent in a literal can never end the line and forge a response. A
store's message is cut after 200 characters the same way. Search for the
fixed part of the text.

| Page | What it covers |
| --- | --- |
| [Configuration and onError](troubleshooting/configuration.md) | what `createImapServer` and `listen` throw, and the errors `onError` receives |
| [Logging in, connections and IDLE](troubleshooting/connections.md) | LOGIN, AUTHENTICATE and STARTTLS, the `BYE`s that end a connection, a TCP proxy's PROXY header, the end of IDLE |
| [Command syntax](troubleshooting/syntax.md) | the tag and the command name, the state, line and literal sizes, and the grammar every command shares |
| [Mailboxes](troubleshooting/mailboxes.md) | mailbox names, SELECT, CREATE, DELETE, RENAME, STATUS and LIST |
| [Messages](troubleshooting/messages.md) | APPEND, FETCH, STORE, SEARCH, COPY and MOVE, and a store call that fails |

**[Configuration and onError](troubleshooting/configuration.md)**

- [`ImapError: createImapServer(): "…" is not a host name`](troubleshooting/configuration.md#imaperror-createimapserver--is-not-a-host-name)
- [`ImapError: createImapServer(): store must be a MailStore, such as new MemoryMailStore()`](troubleshooting/configuration.md#imaperror-createimapserver-store-must-be-a-mailstore-such-as-new-memorymailstore)
- [`ImapError: createImapServer(): authenticate must be a function: it is how users log in`](troubleshooting/configuration.md#imaperror-createimapserver-authenticate-must-be-a-function-it-is-how-users-log-in)
- [`ImapError: createImapServer(): tls: { key, cert } is required, since LOGIN is offered only once encrypted`](troubleshooting/configuration.md#imaperror-createimapserver-tls--key-cert--is-required-since-login-is-offered-only-once-encrypted)
- [`ImapError: createImapServer(): … must be a positive integer, not …`](troubleshooting/configuration.md#imaperror-createimapserver--must-be-a-positive-integer-not-)
- [`ImapError: createImapServer(): … must be at most …, not …`](troubleshooting/configuration.md#imaperror-createimapserver--must-be-at-most--not-)
- [`ImapError: createImapServer(): timeout must be at least 1800 seconds (RFC 9051 §5.4), not …`](troubleshooting/configuration.md#imaperror-createimapserver-timeout-must-be-at-least-1800-seconds-rfc-9051-54-not-)
- [`ImapError: createImapServer(): idleInterval must be a number of seconds, more than 0 and at most 2147483, not …`](troubleshooting/configuration.md#imaperror-createimapserver-idleinterval-must-be-a-number-of-seconds-more-than-0-and-at-most-2147483-not-)
- [`ImapError: createImapServer(): proxyProtocol.trusted must list the addresses or CIDRs of the proxies, at least one`](troubleshooting/configuration.md#imaperror-createimapserver-proxyprotocoltrusted-must-list-the-addresses-or-cidrs-of-the-proxies-at-least-one)
- [`ImapError: createImapServer(): proxyProtocol.trusted: "…" is neither an IP address nor a CIDR`](troubleshooting/configuration.md#imaperror-createimapserver-proxyprotocoltrusted--is-neither-an-ip-address-nor-a-cidr)
- [`ImapError: createImapServer(): proxyProtocol.trusted: "…" has a prefix length out of range`](troubleshooting/configuration.md#imaperror-createimapserver-proxyprotocoltrusted--has-a-prefix-length-out-of-range)
- [`ImapError: createImapServer(): proxyProtocol.trusted: … is not a string`](troubleshooting/configuration.md#imaperror-createimapserver-proxyprotocoltrusted--is-not-a-string)
- [`ImapError: listen(): the server is already listening on …`](troubleshooting/configuration.md#imaperror-listen-the-server-is-already-listening-on-)
- [`ImapError: listen(): the server is already starting to listen`](troubleshooting/configuration.md#imaperror-listen-the-server-is-already-starting-to-listen)
- [`ImapError: listen(): tls: { key, cert } cannot be used: …`](troubleshooting/configuration.md#imaperror-listen-tls--key-cert--cannot-be-used-)
- [`ImapError: authenticate did not settle within hookTimeout (… s)`](troubleshooting/configuration.md#imaperror-authenticate-did-not-settle-within-hooktimeout--s)
- [`Error: authenticate answered the account "…", which the store does not have`](troubleshooting/configuration.md#error-authenticate-answered-the-account--which-the-store-does-not-have)

**[Logging in, connections and IDLE](troubleshooting/connections.md)**

- [`NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first`](troubleshooting/connections.md#no-privacyrequired-log-in-only-once-tls-is-on-starttls-first)
- [`NO [AUTHENTICATIONFAILED] Authentication failed`](troubleshooting/connections.md#no-authenticationfailed-authentication-failed)
- [`NO [UNAVAILABLE] Temporary authentication failure`](troubleshooting/connections.md#no-unavailable-temporary-authentication-failure)
- [`* BYE Too many failed logins, closing`](troubleshooting/connections.md#-bye-too-many-failed-logins-closing)
- [`* BYE Too slow to log in, closing`](troubleshooting/connections.md#-bye-too-slow-to-log-in-closing)
- [`NO [CANNOT] … is not supported: use PLAIN`](troubleshooting/connections.md#no-cannot--is-not-supported-use-plain)
- [`BAD Cannot decode the PLAIN response`](troubleshooting/connections.md#bad-cannot-decode-the-plain-response)
- [`BAD Authentication cancelled`](troubleshooting/connections.md#bad-authentication-cancelled)
- [`BAD TLS is already on`](troubleshooting/connections.md#bad-tls-is-already-on)
- [`* BYE [UNAVAILABLE] Too many connections, try later`](troubleshooting/connections.md#-bye-unavailable-too-many-connections-try-later)
- [On implicit TLS, the connection closes before any greeting](troubleshooting/connections.md#on-implicit-tls-the-connection-closes-before-any-greeting)
- [Connections through the proxy close at once, with no greeting](troubleshooting/connections.md#connections-through-the-proxy-close-at-once-with-no-greeting)
- [A `PROXY BAD` answer, or a failed handshake on 993](troubleshooting/connections.md#a-proxy-bad-answer-or-a-failed-handshake-on-993)
- [Every client shows the proxy's address](troubleshooting/connections.md#every-client-shows-the-proxys-address)
- [Health checks from the proxy show its own address](troubleshooting/connections.md#health-checks-from-the-proxy-show-its-own-address)
- [`* BYE Idle for too long, closing`](troubleshooting/connections.md#-bye-idle-for-too-long-closing)
- [`* BYE The selected mailbox was deleted, closing`](troubleshooting/connections.md#-bye-the-selected-mailbox-was-deleted-closing)
- [`* BYE Internal error, closing`](troubleshooting/connections.md#-bye-internal-error-closing)
- [`BAD Expected DONE`](troubleshooting/connections.md#bad-expected-done)

**[Command syntax](troubleshooting/syntax.md)**

- [`* BAD Missing or invalid tag`](troubleshooting/syntax.md#-bad-missing-or-invalid-tag)
- [`BAD Missing command`](troubleshooting/syntax.md#bad-missing-command)
- [`BAD … is not valid in the … state`](troubleshooting/syntax.md#bad--is-not-valid-in-the--state)
- [`BAD Unknown command …`](troubleshooting/syntax.md#bad-unknown-command-)
- [`BAD Command line too long`](troubleshooting/syntax.md#bad-command-line-too-long)
- [`BAD [TOOBIG] Literal over … bytes`](troubleshooting/syntax.md#bad-toobig-literal-over--bytes)
- [`BAD More than 32 literals in one command`](troubleshooting/syntax.md#bad-more-than-32-literals-in-one-command)
- [`BAD [TOOBIG] Literal over 1024 bytes before login`](troubleshooting/syntax.md#bad-toobig-literal-over-1024-bytes-before-login)
- [`BAD More than 2 literals before login`](troubleshooting/syntax.md#bad-more-than-2-literals-before-login)
- [`BAD Lists nest too deep` and `BAD Search keys nest too deep`](troubleshooting/syntax.md#bad-lists-nest-too-deep-and-bad-search-keys-nest-too-deep)
- [`BAD Expected …`](troubleshooting/syntax.md#bad-expected-)
- [`BAD Unexpected text at the end of the command`](troubleshooting/syntax.md#bad-unexpected-text-at-the-end-of-the-command)
- [`BAD Unterminated quoted string`, `BAD A quoted string cannot hold a CR`, `BAD A quoted string escapes only " and \`](troubleshooting/syntax.md#bad-unterminated-quoted-string-bad-a-quoted-string-cannot-hold-a-cr-bad-a-quoted-string-escapes-only--and-)
- [`BAD A literal ends its line: {size}`](troubleshooting/syntax.md#bad-a-literal-ends-its-line-size)
- [`BAD A number is at most 4294967295`](troubleshooting/syntax.md#bad-a-number-is-at-most-4294967295)
- [`BAD No such message`](troubleshooting/syntax.md#bad-no-such-message)
- [`BAD $ (SEARCHRES) is not supported`](troubleshooting/syntax.md#bad--searchres-is-not-supported)

**[Mailboxes](troubleshooting/mailboxes.md)**

- [`BAD "…" is not a valid modified UTF-7 mailbox name`](troubleshooting/mailboxes.md#bad--is-not-a-valid-modified-utf-7-mailbox-name)
- [`BAD "…" has an empty level`](troubleshooting/mailboxes.md#bad--has-an-empty-level)
- [`NO [LIMIT] A mailbox name has at most 32 levels`](troubleshooting/mailboxes.md#no-limit-a-mailbox-name-has-at-most-32-levels)
- [`NO [LIMIT] A mailbox name is at most 1024 characters`](troubleshooting/mailboxes.md#no-limit-a-mailbox-name-is-at-most-1024-characters)
- [`NO [LIMIT] A level of a mailbox name is at most 255 characters`](troubleshooting/mailboxes.md#no-limit-a-level-of-a-mailbox-name-is-at-most-255-characters)
- [`NO [CANNOT] A level of a mailbox name cannot begin or end with white space`](troubleshooting/mailboxes.md#no-cannot-a-level-of-a-mailbox-name-cannot-begin-or-end-with-white-space)
- [`NO [CANNOT] A mailbox name cannot hold a control character`](troubleshooting/mailboxes.md#no-cannot-a-mailbox-name-cannot-hold-a-control-character)
- [`BAD CREATE parameters are not supported`](troubleshooting/mailboxes.md#bad-create-parameters-are-not-supported)
- [`BAD SELECT parameters are not supported`, `BAD EXAMINE parameters are not supported`](troubleshooting/mailboxes.md#bad-select-parameters-are-not-supported-bad-examine-parameters-are-not-supported)
- [`BAD Unknown STATUS item …`](troubleshooting/mailboxes.md#bad-unknown-status-item-)
- [`BAD STATUS needs at least one item`](troubleshooting/mailboxes.md#bad-status-needs-at-least-one-item)
- [`BAD Unknown LIST selection option …`](troubleshooting/mailboxes.md#bad-unknown-list-selection-option-)
- [`BAD Unknown LIST return option …`](troubleshooting/mailboxes.md#bad-unknown-list-return-option-)
- [`BAD RECURSIVEMATCH needs another selection option (RFC 5258 §3)`](troubleshooting/mailboxes.md#bad-recursivematch-needs-another-selection-option-rfc-5258-3)
- [`BAD Expected RETURN`](troubleshooting/mailboxes.md#bad-expected-return)
- [`BAD The pattern is too long`](troubleshooting/mailboxes.md#bad-the-pattern-is-too-long)
- [`BAD More than 16 patterns in one LIST`](troubleshooting/mailboxes.md#bad-more-than-16-patterns-in-one-list)
- [`NO [NONEXISTENT] No such mailbox`](troubleshooting/mailboxes.md#no-nonexistent-no-such-mailbox)
- [`NO [TRYCREATE] No such mailbox`](troubleshooting/mailboxes.md#no-trycreate-no-such-mailbox)
- [`NO [ALREADYEXISTS] The mailbox already exists`](troubleshooting/mailboxes.md#no-alreadyexists-the-mailbox-already-exists)
- [`NO [ALREADYEXISTS] The new name is taken`](troubleshooting/mailboxes.md#no-alreadyexists-the-new-name-is-taken)
- [`NO [CANNOT] INBOX cannot be deleted`](troubleshooting/mailboxes.md#no-cannot-inbox-cannot-be-deleted)
- [`NO [CANNOT] Delete the mailboxes inside it first`](troubleshooting/mailboxes.md#no-cannot-delete-the-mailboxes-inside-it-first)
- [`NO [INUSE] The mailbox is selected: close it first`](troubleshooting/mailboxes.md#no-inuse-the-mailbox-is-selected-close-it-first)
- [`NO [CANNOT] Renaming INBOX is not supported`](troubleshooting/mailboxes.md#no-cannot-renaming-inbox-is-not-supported)
- [`NO [CANNOT] A mailbox cannot move inside itself`](troubleshooting/mailboxes.md#no-cannot-a-mailbox-cannot-move-inside-itself)
- [A store's own refusal: `NO [NONEXISTENT] …`, `NO [ALREADYEXISTS] …`, `NO [CANNOT] …`](troubleshooting/mailboxes.md#a-stores-own-refusal-no-nonexistent--no-alreadyexists--no-cannot-)

**[Messages](troubleshooting/messages.md)**

- [`NO [TOOBIG] The message is over … bytes`](troubleshooting/messages.md#no-toobig-the-message-is-over--bytes)
- [`BAD MULTIAPPEND is not supported`](troubleshooting/messages.md#bad-multiappend-is-not-supported)
- [`BAD Unexpected text after the message`](troubleshooting/messages.md#bad-unexpected-text-after-the-message)
- [`BAD Invalid flag`](troubleshooting/messages.md#bad-invalid-flag)
- [`BAD "…" is not a date-time`](troubleshooting/messages.md#bad--is-not-a-date-time)
- [`BAD Unknown FETCH item …`](troubleshooting/messages.md#bad-unknown-fetch-item-)
- [`BAD Unknown section …`](troubleshooting/messages.md#bad-unknown-section-)
- [`BAD MIME needs a part number`](troubleshooting/messages.md#bad-mime-needs-a-part-number)
- [`BAD HEADER.FIELDS needs a field name`](troubleshooting/messages.md#bad-headerfields-needs-a-field-name)
- [`BAD A partial length is at least 1`](troubleshooting/messages.md#bad-a-partial-length-is-at-least-1)
- [`BAD A part number is at least 1`](troubleshooting/messages.md#bad-a-part-number-is-at-least-1)
- [`BAD FETCH modifiers are not supported`, `BAD STORE modifiers are not supported`](troubleshooting/messages.md#bad-fetch-modifiers-are-not-supported-bad-store-modifiers-are-not-supported)
- [`BAD BINARY is not supported yet`](troubleshooting/messages.md#bad-binary-is-not-supported-yet)
- [`BAD Unknown STORE item …`](troubleshooting/messages.md#bad-unknown-store-item-)
- [`NO [CANNOT] "…" is not a flag a store keeps`](troubleshooting/messages.md#no-cannot--is-not-a-flag-a-store-keeps)
- [`NO [READ-ONLY] The mailbox is read-only`](troubleshooting/messages.md#no-read-only-the-mailbox-is-read-only)
- [`BAD Unknown search key …, or its argument is missing`](troubleshooting/messages.md#bad-unknown-search-key--or-its-argument-is-missing)
- [`BAD Unsupported SEARCH return option …`](troubleshooting/messages.md#bad-unsupported-search-return-option-)
- [`BAD Expected a date such as 1-Feb-1994`](troubleshooting/messages.md#bad-expected-a-date-such-as-1-feb-1994)
- [`BAD More than 32 TEXT or BODY keys in one SEARCH`](troubleshooting/messages.md#bad-more-than-32-text-or-body-keys-in-one-search)
- [`NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset`](troubleshooting/messages.md#no-badcharset-utf-8-us-ascii-unsupported-charset)
- [`NO [SERVERBUG] Internal error`](troubleshooting/messages.md#no-serverbug-internal-error)

**Traps**

- [A client says the server does not support CONDSTORE](#a-client-says-the-server-does-not-support-condstore)
- [New mail shows up seconds late](#new-mail-shows-up-seconds-late)

---

## A client says the server does not support CONDSTORE

It does not yet; the [roadmap](roadmap.md) has it. Clients fall back to
fetching flags, which costs more on large mailboxes.

## New mail shows up seconds late

IDLE looks at the store every `idleInterval` seconds (10). Call
`server.notify(accountId)` after delivering, or lower `idleInterval`.
