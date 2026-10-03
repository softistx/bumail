---
"@bumail/store": minor
---

`messageChanges` takes a `mailboxId` (the new `MessageChangesOptions`) to list only one mailbox's changes: a message moved in is `created`, one moved out `destroyed`, and `expunged` holds only that mailbox's UIDs; a mailbox the account does not have is `NOT_FOUND`. Its `limit` now counts the `expunged` entries too, so a page returns more than asked for only when one modseq alone holds more, or when a page since 0 must reach the oldest `since` the store still answers.
