---
"@bumail/smtp": patch
---

A client that stops reading no longer holds a connection slot for good. When the server hangs up on its own — the idle `timeout`, `maxErrors`, three failed AUTH attempts, a refusal from `onConnect`, a local error — it writes its reply and closes at once: the connection leaves `server.connections` then, and replies the client never read are dropped, the connection reset if any were still waiting. Such a close used to wait for the client to read first, which a client that pipelined commands and never read never did, so enough of them filled `maxConnections` and locked every other client out. `QUIT` is unchanged: the `221` leaves whole, then the server hangs up; and a `221` that is never read is dropped at the idle `timeout`.
