# @bumail/store

## 0.1.0

### Minor Changes

- [#11](https://github.com/softistx/bumail/pull/11) [`1b5bdad`](https://github.com/softistx/bumail/commit/1b5bdad1c41ab7c1ae09115d3b08e3e0baf2981a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `messageChanges` takes a `mailboxId` (the new `MessageChangesOptions`) to list only one mailbox's changes: a message moved in is `created`, one moved out `destroyed`, and `expunged` holds only that mailbox's UIDs; a mailbox the account does not have is `NOT_FOUND`. Its `limit` now counts the `expunged` entries too, so a page returns more than asked for only when one modseq alone holds more, or when a page since 0 must reach the oldest `since` the store still answers.

- [#3](https://github.com/softistx/bumail/pull/3) [`d3ed963`](https://github.com/softistx/bumail/commit/d3ed963014730ebfe138f80d3a5de0ea09bbd066) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The first release of `@bumail/store`: the `MailStore` contract and `MemoryMailStore`, its answer in memory.
  
  - Accounts; mailboxes with the IANA roles (RFC 6154, RFC 8457), a hierarchy through `parentId`, a subscription, `INBOX` case-insensitive; `renameMailbox` changes only the name or parent it is given, `parentId: null` moving to the top.
  - Messages with one id and one thread for their life, in one mailbox or several, with a UID in each; content given as bytes or a stream, kept per account, read back as a `Blob`; every message of an account with `listAccountMessages`.
  - Flags, keywords in lowercase, and RFC 7162's `unchangedSince`.
  - IMAP COPY, MOVE and EXPUNGE, and JMAP's links and destroys; an id already gone is skipped and listed in `notFound`.
  - `messageChanges` and `mailboxChanges` since a modseq, paged with `limit`, with every UID expunged since for QRESYNC (RFC 7162 §3.2.6); since 0 always gives the whole state, in pages that can always be followed.
  - Every method but the account's own takes the account first, and acts only in it: another account's mailbox is `NOT_FOUND`, its message is in `notFound`, its blob `undefined`.
  - Every call all or nothing; nothing returned shared with what the store keeps.

### Patch Changes

- [#13](https://github.com/softistx/bumail/pull/13) [`22a487c`](https://github.com/softistx/bumail/commit/22a487c644c24859273bf930a15f3f6a73633323) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The roadmap says the changes can be asked for one mailbox; edited doc lines rewrapped.

- [#7](https://github.com/softistx/bumail/pull/7) [`bc55684`](https://github.com/softistx/bumail/commit/bc556843f31e3ac206df263f554ba2bbe74871fc) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The README links the docs index, and the roadmap lists the contract and its memory store as shipped.

- [#6](https://github.com/softistx/bumail/pull/6) [`169fbda`](https://github.com/softistx/bumail/commit/169fbdadef4383cb6e927e2a8db67d0aa680bc16) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The guide now states once that a `renameMailbox` change naming neither `name` nor `parentId` does not compile.

- [#5](https://github.com/softistx/bumail/pull/5) [`5395e28`](https://github.com/softistx/bumail/commit/5395e2862303d5e483ecbab5efaace83b15a136a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `findMailbox`'s role check moves into the contract's shared helpers, beside `createMailbox`'s, with no change in behaviour; a contract spec now pins that a message added and destroyed since a modseq is still listed in `expunged`.
