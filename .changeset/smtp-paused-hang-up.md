---
'@bumail/smtp': patch
---

Free the slot within 500 ms instead of 5 seconds when the server hangs up — the idle timeout, `maxErrors`, a local error, or after `QUIT` — on a client whose input it had paused, as when the client pipelines more than the server can take: the half-close did not complete over the unread input, so the connection kept its place under `maxConnections` for the 5-second grace. The server now reads again before it half-closes, dropping what comes until the client's input stops for 20 ms, and a client whose input went quiet for 20 ms within 500 ms of the hang-up still reads the last reply and a clean end — on Linux too, where a close over input left unread is a reset that lost the reply. It waits 500 ms at most: input not quiet for 20 ms by then — a client still sending, or one that stopped in the last 20 ms — is reset, so the socket closes within 500 ms however the client sends.
