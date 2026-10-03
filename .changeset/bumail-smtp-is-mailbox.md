---
"@bumail/smtp": minor
---

`@bumail/smtp/client` exports `isMailbox(address)`: whether an address is exactly one `sendMail` takes (the two share one predicate): an RFC 5321 Mailbox, `local@domain`, with no source route, no control character (C0, DEL or C1), no `>`, no U+2028 or U+2029, no Unicode format character (`\p{Cf}`), no lone surrogate and no IPv4 literal octet above 255. Code that keeps addresses for later (a queue) refuses a bad one when it takes it, rather than have `sendMail` refuse it with `INVALID_OPTION` at delivery.
