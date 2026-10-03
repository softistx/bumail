---
"@bumail/smtp": patch
---

A read of `message.content` still running when `onData` answers errors with `MESSAGE_NOT_READ` at once, so it never reaches a clean end once the client is told `451`. The guide shows delivering into `@bumail/store`.
