---
"@bumail/smtp": minor
---

`@bumail/smtp/client` exports `isMailbox(address)`: whether an address is an RFC 5321 Mailbox, `local@domain` with no source route, which `sendMail` always takes, so code that keeps addresses for later (a queue) can refuse a bad one when it takes it rather than have `sendMail` refuse it with `INVALID_OPTION` at delivery.
