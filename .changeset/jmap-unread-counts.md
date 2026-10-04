---
'@bumail/jmap': patch
---

A mailbox's `unreadEmails` and `unreadThreads` follow RFC 8621 §2: an email with `$seen` is read however the store keeps it — `\Seen`, or a `$Seen` keyword in any case — and an email with `$draft` (`\Draft` or a `$Draft` keyword) is never unread. They no longer come from the store's IMAP `unseen` count, which looks for `\Seen` alone; they are counted in the same pass over the mailbox as the thread counts, within `maxQueryScan`; past `maxQueryScan`, the store's `unseen` still stands in.
