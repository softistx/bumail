---
'@bumail/smtp': patch
---

Security: refuse a source route in `sendMail`'s `from` and `to`, and any control character in an address. The client checked an address as an RFC 5321 path but dropped a source route (`@host:`) without looking at it, and then wrote the address as given, so on a server offering SMTPUTF8 `to: '@x\r\nRSET\r\nNOOP:a@c.com'` put `RCPT TO:<@x\r\nRSET\r\nNOOP:a@c.com>` on the wire, which the server read as three commands. `sendMail` now refuses any source route before it connects — RFC 5321 §4.1.1.3 says a client should not send one — with `"…" holds a source route (@host:), which RFC 5321 says a client should not send: pass "…" alone` for an otherwise valid one, and `is not an address` for the rest. `parsePath` refuses a C0 control (CR, LF, NUL…), DEL or `>` anywhere in a path, and takes a source route only as `@domain(,@domain)*:` with each hop a valid domain; its new third argument, `'discard'` (the default, the server's) or `'refuse'` (the client's), says what to do with a valid one. The server still accepts and drops a valid route, and answers any other with `501 5.5.4 Syntax`. Upgrade if `from` or `to` can come from user input.

`parsePath`, and so `sendMail` and the server, also refuse a lone surrogate (`to: 'a\uD800@c.com'`, which reached the wire as U+FFFD) and an IPv4 address literal with an octet above 255 (`[999.1.1.1]`).

`helo: '[IPv6:2001:db8::1]'` is taken, and the server accepts `EHLO [IPv6:2001:db8::1]`: both refused the `IPv6:` tag's `P`, and both took `[999.1.1.1]`. An IPv6 literal without its tag (`helo: '[2001:db8::1]'`, `EHLO [2001:db8::1]`), which both took, is now refused, as RFC 5321 §4.1.3 asks: write `[IPv6:2001:db8::1]`.
