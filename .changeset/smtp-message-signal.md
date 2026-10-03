---
"@bumail/smtp": minor
---

`ReceivedMessage.signal`, an `AbortSignal` that aborts whenever the server refuses the message on `onData`'s behalf — late, a throw, an answer that is not a refusal, an acceptance before the read finished, the stream's own errors, or the connection closed before the reply — including when the read had already ended cleanly. Its `reason` is the `SmtpError`, or what `onData` threw; a refusal `onData` returns itself leaves it alone. The idle `timeout` now starts again when the 220 goes out, so `greetingDelay` and `onConnect` no longer take from it.
