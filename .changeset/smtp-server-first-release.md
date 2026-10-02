---
"@bumail/smtp": minor
---

The first release of `@bumail/smtp`: `createSmtpServer`, an SMTP server on `Bun.listen` (RFC 5321) with PIPELINING, SIZE, 8BITMIME, SMTPUTF8 and ENHANCEDSTATUSCODES; STARTTLS and implicit TLS; AUTH PLAIN and LOGIN over TLS only; hooks for connect, MAIL FROM, RCPT TO and DATA. It never relays without AUTH, and refuses a message holding a bare CR or LF (SMTP smuggling).
