---
"@bumail/smtp": patch
---

`server.stop(true)` now hangs up on a session that went through STARTTLS. Bun's listener no longer holds a socket once it moves to TLS, so such a session stayed open after `stop(true)`, still counted in `server.connections`, until the client left or its idle `timeout` came. The server now closes every connection it holds, as a timeout does.

A hang-up on TLS that waited for replies to leave no longer loses the last of them. Half-closing the socket at the moment the queue drained could drop what Bun still held in its own TLS buffer, so a client reading slowly saw a clean end up to 96 KiB short. That hang-up now closes once the client answers, within the same 5-second grace; every other hang-up still half-closes at once.
