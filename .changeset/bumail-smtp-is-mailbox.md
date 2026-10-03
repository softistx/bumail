---
"@bumail/smtp": minor
---

`@bumail/smtp/client` exports `isMailbox(address)`: whether an address is exactly one `sendMail` takes (the two share one predicate): an RFC 5321 Mailbox, `local@domain`, with no source route, no control character, no `>` and no lone surrogate. Code that keeps addresses for later (a queue) refuses a bad one when it takes it, rather than have `sendMail` refuse it with `INVALID_OPTION` at delivery.
