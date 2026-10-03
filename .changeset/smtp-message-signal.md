---
"@bumail/smtp": minor
---

`ReceivedMessage.signal`, an `AbortSignal` that aborts whenever the server refuses the message on `onData`'s behalf — late, a throw, an answer that is not a refusal, an acceptance before the read finished, the stream's own errors, or the connection closed before the reply — including when the read had already ended cleanly. Its `reason` is the `SmtpError`, or what `onData` threw; a refusal `onData` returns leaves it alone, unless the client never hears it: a later stream failure (whose 552 or 550 replaces `onData`'s reply) or a closed connection still aborts it, with that error. The idle `timeout` now starts again when the 220 goes out, so `greetingDelay` and `onConnect` no longer take from it.
