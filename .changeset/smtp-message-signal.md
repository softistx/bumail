---
"@bumail/smtp": minor
---

`ReceivedMessage.signal`, an `AbortSignal` that aborts with the `SmtpError` as its reason whenever the server refuses a message `onData` was given — including an `onData` that read the whole message but answered after `hookTimeout`, whose read ended cleanly. The idle `timeout` now starts again when the 220 goes out, so `greetingDelay` and `onConnect` no longer take from it.
