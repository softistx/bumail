---
"@bumail/smtp": minor
---

The first release of `@bumail/smtp`: `createSmtpServer`, an SMTP server on `Bun.listen` (RFC 5321) with PIPELINING, SIZE, 8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and implicit TLS; AUTH PLAIN and LOGIN over TLS only; hooks for connect, MAIL FROM, RCPT TO and DATA, with `hookTimeout` and `onError`; each message handed to `onData` as a `ReadableStream` with backpressure; option and stream errors as `SmtpError` with a `code`. It never relays without AUTH, refuses a message holding a bare CR or LF (SMTP smuggling), refuses a client that talks before the greeting, and bounds the memory a client can make it hold.
