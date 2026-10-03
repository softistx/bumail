---
"@bumail/smtp": minor
---

`ReceivedMessage.signal`, an `AbortSignal` that aborts whenever the message is refused for a reason `onData` did not answer itself — late, a throw, an answer that is not a refusal, a read not finished, or a client gone before the reply — including when the read had already ended cleanly. Its `reason` is the `SmtpError`, or what `onData` threw. The idle `timeout` now starts again when the 220 goes out, so `greetingDelay` and `onConnect` no longer take from it.
