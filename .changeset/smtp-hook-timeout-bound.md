---
"@bumail/smtp": patch
---

`createSmtpServer` refuses a `hookTimeout` past 2 147 483 seconds with `INVALID_OPTION` (`hookTimeout must be at most 2147483 seconds, not …`). A longer one overflowed `setTimeout`, which then fired after 1 ms, so every hook timed out and every MAIL FROM, RCPT TO and message was refused with `451 4.3.0`.
