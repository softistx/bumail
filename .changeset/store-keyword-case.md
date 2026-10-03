---
'@bumail/store': patch
---

Keep a keyword in the case it was first stored with — `$Forwarded`, `$MDNSent`, `NonJunk` — instead of lowercasing it, in the memory and the SQLite stores alike. Keywords still compare without case (RFC 9051 §2.3.2): a message never holds two that differ only by case, `add`, `remove` and `set` match them without case, and adding `$junk` to a message with `$Junk` changes nothing. Flags sort without case. Keywords stored lowercase by an earlier version stay as they are.
