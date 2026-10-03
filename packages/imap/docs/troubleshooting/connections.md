# Troubleshooting: logging in, connections and IDLE

The responses to LOGIN, AUTHENTICATE and STARTTLS, the `BYE`s that end a
connection, and the end of IDLE. The [index](../troubleshooting.md) lists
every entry of every page. A tagged response starts with the client's tag
(`a1 NO …`); it is left out here.

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
not extend it. Its place under `maxConnections` is free at once, whether
the client reads or not. A client that paused with nothing queued for it
still reads this BYE, then a clean end, when it reads again; one with
output still queued — responses it never read — does not see it: the
server drops that output and resets the connection.

## `NO [CANNOT] … is not supported: use PLAIN`

Only AUTHENTICATE PLAIN is offered (`AUTH=PLAIN`). Set the client to
*Normal password*.

## `BAD Cannot decode the PLAIN response`

The PLAIN response was not base64 of `authzid NUL username NUL password`.

## `BAD Authentication cancelled`

The client answered the server's `+` continuation of AUTHENTICATE PLAIN
with `*`, which cancels the exchange (RFC 9051 §6.2.2). It is not a failed
login, and does not count toward the three. A client does this when it has
no password to give: check the account's saved credentials, or that it is
set to *Normal password*.

## `BAD TLS is already on`

STARTTLS on a connection that is already encrypted: implicit TLS on 993,
or a second STARTTLS.

## `* BYE [UNAVAILABLE] Too many connections, try later`

`maxConnections` (1000) are open. Raise it, or look for a client that
opens a connection per folder without closing them.

## `* BYE Idle for too long, closing`

Nothing came from the client for `timeout` seconds (1800). Clients send
NOOP or restart IDLE before that. As with `Too slow to log in`, a client
that does not read is hung up on without waiting for it: with nothing
queued, it reads this BYE and a clean end later; with output queued, the
connection is reset without it.

Any other hang-up — LOGOUT, a BYE for a protocol error — sends its last
words and half-closes the socket at once; output still queued then waits
at most 5 seconds for the client to read it, then the connection is
reset.

## `* BYE The selected mailbox was deleted, closing`

Another session, or your app, deleted the mailbox this session had
selected. The client reconnects and lists the mailboxes again.

## `* BYE Internal error, closing`

Something failed in the server itself while it read the client's input,
outside any one command: a command that fails is answered `NO` or `BAD`
and the connection goes on, so this is a bug in `@bumail/imap`, not in
your hook or your store. `onError` has the error and the session; please
report it with the client's last commands. The client reconnects.

## `BAD Expected DONE`

During IDLE the only line a client may send is `DONE` (RFC 2177); the
server got another one. IDLE ends there, with this `BAD` in place of
`OK IDLE terminated`, and the line is not run as a command. A client that
pipelines its next command without waiting to send `DONE` does this; so
does a hand-typed session that sends `a2 DONE`. Send `DONE` alone, any
case, then the next command.
