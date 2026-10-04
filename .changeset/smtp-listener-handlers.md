---
"@bumail/smtp": patch
---

The listener's `open`, `handshake` and `close` handlers move out of `createSmtpServer` into a function of their own. Nothing a consumer sees changes. `stop(true)` resets a socket still in its implicit TLS handshake instead of closing its connection, which had no TLS to write a 421 on; Bun's own `stop(true)` already closed such a socket, so nothing a consumer sees changes there either.
