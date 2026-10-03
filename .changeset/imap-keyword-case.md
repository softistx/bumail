---
'@bumail/imap': patch
---

Return keywords as the client set them, and compare them without case: `SEARCH KEYWORD` and `UNKEYWORD` match whatever the case, and FLAGS and PERMANENTFLAGS list a keyword once, in its stored case. Free the slot at once on any hang-up — the login or idle timeout, LOGOUT, a BYE, `stop(true)` — of a client the server had stopped reading because it sent more than the server could take: a half-close does not complete over that unread input, and the connection held its place under `maxConnections` for the 5-second grace. The server now reads again before it half-closes, dropping what comes until the client's input stops for 20 ms (500 ms at most), so the socket closes at once, and a client that stopped sending still reads the BYE and a clean end — on Linux too, where a close over input left unread is a reset that lost the BYE.
