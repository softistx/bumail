---
"@bumail/smtp": minor
---

`@bumail/smtp/client` exports `isMailbox(address)`: whether `sendMail` takes an address as `local@domain`, by the same RFC 5321 grammar it checks with, so code that keeps addresses for later (a queue) can refuse a bad one when it takes it rather than have `sendMail` refuse it with `INVALID_OPTION` at delivery.
