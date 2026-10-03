---
'@bumail/smtp': patch
---

Free the slot at once when the server hangs up — the idle timeout, `maxErrors`, a local error, or after `QUIT` — on a client whose input it had paused, as when the client pipelines more than the server can take: the half-close did not complete over the unread input, so the connection kept its place under `maxConnections` for the 5-second grace. The server now reads again before it half-closes, dropping what comes, so the socket closes at once, and a client that stopped sending still reads the last reply and a clean end.
