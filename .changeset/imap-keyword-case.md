---
'@bumail/imap': patch
---

Return keywords as the client set them, and compare them without case: `SEARCH KEYWORD` and `UNKEYWORD` match whatever the case, and FLAGS and PERMANENTFLAGS list a keyword once, in its stored case. A forced hang-up — the idle or login timeout, a BYE — now resets the connection when the server had paused reading a client that sent more than it could take: a half-close does not complete over that unread input, and the connection held its slot for the 5-second grace.
