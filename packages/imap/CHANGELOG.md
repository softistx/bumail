# @bumail/imap

## 0.2.0

### Minor Changes

- [#65](https://github.com/softistx/bumail/pull/65) [`62f9b19`](https://github.com/softistx/bumail/commit/62f9b19bad0d8f1897f91369a59cd2b07ad30825) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The implicit TLS handshake is bounded. On an `implicitTls` port a socket is now counted by `maxConnections` from the TCP connection on, not from the end of its handshake, and closed without a word past the new `handshakeTimeout` (default 10 seconds) when its handshake has not completed: before, a socket that never sent its ClientHello was counted by no limit and closed by no timer. The greeting, and the `BYE` of a full server, wait for the handshake, and `loginTimeout` starts with the greeting. `stop(true)` resets a socket still in its handshake.

## 0.1.2

### Patch Changes

- Updated dependencies [[`4c22182`](https://github.com/softistx/bumail/commit/4c22182470c9fd13d1f78a5a3d14785667745c52)]:
  - @bumail/store@0.4.0

## 0.1.1

### Patch Changes

- [#34](https://github.com/softistx/bumail/pull/34) [`5fecf59`](https://github.com/softistx/bumail/commit/5fecf5968a10baf27b28507167d2dc5693182c98) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Return keywords as the client set them, and compare them without case: `SEARCH KEYWORD` and `UNKEYWORD` match whatever the case, and FLAGS and PERMANENTFLAGS list a keyword once, in its stored case. Free the slot within 500 ms instead of 5 seconds on any hang-up — the login or idle timeout, LOGOUT, a BYE, `stop(true)` — of a client the server had stopped reading because it sent more than the server could take: a half-close does not complete over that unread input, and the connection held its place under `maxConnections` for the 5-second grace. The server now reads again before it half-closes, dropping what comes until the client's input stops for 20 ms, and a client whose input went quiet for 20 ms within 500 ms of the hang-up still reads the BYE and a clean end — on Linux too, where a close over input left unread is a reset that lost the BYE. It waits 500 ms at most: input not quiet for 20 ms by then — a client still sending, or one that stopped in the last 20 ms — is reset, so the socket closes within 500 ms however the client sends.
- Updated dependencies [[`e5f50d4`](https://github.com/softistx/bumail/commit/e5f50d46a2c14aa2a9fec2f1574e66a90086a0c0), [`6960313`](https://github.com/softistx/bumail/commit/69603137a0dc546ef49a10ba5e171057d08b141a)]:
  - @bumail/mime@0.1.2
  - @bumail/store@0.3.0

## 0.1.0

### Minor Changes

- [#29](https://github.com/softistx/bumail/pull/29) [`4f7064c`](https://github.com/softistx/bumail/commit/4f7064c52312ea2f2ebde9029cd17c97036a1174) Thanks [@SteveGT96](https://github.com/SteveGT96)! - A new package: an IMAP4rev2 server (RFC 9051) on `Bun.listen` that serves the mail of any `@bumail/store` `MailStore`. `createImapServer({ hostname, store, tls, authenticate })` listens on 143 with STARTTLS or on 993 with `implicitTls`; LOGIN and AUTHENTICATE PLAIN (with SASL-IR) are refused before TLS, with `LOGINDISABLED` advertised. It answers CAPABILITY, NOOP, LOGOUT, ENABLE, SELECT, EXAMINE, CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE, LIST (SPECIAL-USE, LIST-EXTENDED, LIST-STATUS), STATUS, NAMESPACE, APPEND (streamed into the store, APPENDLIMIT), CLOSE, UNSELECT, EXPUNGE, UID EXPUNGE, FETCH (envelope, body structure, sections and partials read in one streaming pass), STORE, COPY, MOVE, SEARCH (ESEARCH) and IDLE; IMAP4rev1 clients are served too. Changes made elsewhere reach the selected mailbox as EXISTS, EXPUNGE and FETCH; `server.notify(accountId)` wakes IDLE sessions at once. Input is bounded — line length, literal sizes, literals per command (2 of 1 KiB at most before login), nesting, mailbox names (32 levels, 1024 characters, 255 a level, none with white space at either end or a control character, all checked before any parent is created), LIST patterns (16) and SEARCH TEXT or BODY keys (32) — client text is never repeated raw in a response, and a slow client, even one that never reads, is cut by `loginTimeout` and `timeout` (at least 30 minutes) and gives back its `maxConnections` slot at once, on TLS as on a clear socket: a hang-up half-closes the socket and never waits for the client to answer, so a client that paused still reads the last `BYE`, then a clean end, when it reads again; output still queued waits 5 seconds at most, then the connection is reset (on TLS, once it has left, the server closes when the client answers, within the same 5 seconds). `server.stop(true)` hangs up on every connection, those moved to TLS by STARTTLS included. CONDSTORE, QRESYNC, UIDPLUS's response codes and BINARY are not implemented yet.
