---
"@bumail/smtp": patch
---

The listener's `open`, `handshake` and `close` handlers move out of `createSmtpServer` into a function of their own. Nothing a consumer sees changes.
