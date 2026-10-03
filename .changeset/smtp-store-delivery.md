---
"@bumail/smtp": patch
---

A read of `message.content` left running after `onData` answered now errors with `MESSAGE_NOT_READ` at once, instead of reaching a clean end after the client was told `451`. The guide shows delivering into `@bumail/store`.
