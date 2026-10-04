---
"@bumail/imap": minor
---

The implicit TLS handshake is bounded. On an `implicitTls` port a socket is now counted by `maxConnections` from the TCP connection on, not from the end of its handshake, and closed without a word past the new `handshakeTimeout` (default 10 seconds) when its handshake has not completed: before, a socket that never sent its ClientHello was counted by no limit and closed by no timer. The greeting, and the `BYE` of a full server, wait for the handshake, and `loginTimeout` starts with the greeting. `stop(true)` resets a socket still in its handshake.
