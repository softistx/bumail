# @bumail/store

Where a mail server keeps its mail: accounts, mailboxes, messages, flags,
UIDs and modseqs behind one contract, `MailStore`, with a memory store.
Every store answers the contract the same way, so the SMTP server, IMAP
and JMAP never know which one they were given. No dependency.

```sh
bun add @bumail/store
```

## Usage

```ts
import { MemoryMailStore } from '@bumail/store';

const store = new MemoryMailStore();
const account = await store.createAccount('mary@example.net');
const inbox = await store.createMailbox(account.id, { name: 'INBOX', role: 'inbox' });

const raw = new TextEncoder().encode('Subject: Hello\r\n\r\nHi Mary\r\n');
const message = await store.addMessage(inbox.id, { content: raw }); // or a ReadableStream
message.mailboxes[0]?.uid; // 1, then 2, 3… — never reused in this mailbox
await store.setFlags([message.id], { add: ['\\Seen'] });

const content = await store.readContent(message.blobId); // a Blob
await content?.text();
```

## Messages and mailboxes

A message is one message for its whole life, as JMAP sees it: one id, its
own flags, in one mailbox or several. IMAP sees it through each mailbox it
is in, with a UID there.

```ts
const archive = await store.createMailbox(account.id, { name: 'Archive', role: 'archive' });
await store.moveMessages([message.id], inbox.id, archive.id); // same id, new UID in Archive
await store.linkMessages([message.id], inbox.id); // in both now
await store.copyMessages([message.id], archive.id); // IMAP COPY: a new message
await store.removeMessages([message.id], inbox.id); // out of INBOX, still in Archive
```

## Keeping in sync

Every change in an account takes the account's next **modseq**. Ask for
what changed since the last one you saw:

```ts
let since = 0;
const changes = await store.messageChanges(account.id, since, { limit: 500 });
changes.created; changes.updated; changes.destroyed; // message ids
changes.expunged; // { mailboxId, uid } for IMAP's VANISHED
since = changes.modseq; // next time; ask again at once while changes.hasMore
```

`mailboxChanges` does the same for mailboxes. This is what IMAP's
CONDSTORE and QRESYNC (RFC 7162) and JMAP's `/changes` need.

## Writing a store

A store implements `MailStore`, throws `StoreError` with the contract's
codes, and passes the contract's specs: every call all or nothing, and
nothing it returns shared with what it keeps. Content is addressed by
`blobIdOf(content)`, its SHA-256, so the same bytes have the same id in
every store.

## API

| export | |
| --- | --- |
| `MailStore` | the contract: accounts, mailboxes, messages, flags, changes |
| `MemoryMailStore`, `MemoryMailStoreOptions` | the contract in memory; `maxTombstones` bounds what it remembers of removals |
| `Account`, `Mailbox`, `MailboxRole`, `Message`, `Membership`, `MailboxEntry`, `Expunged` | what a store returns |
| `MessageChanges`, `MailboxChanges`, `FlagResult` | what the changes and `setFlags` return |
| `NewMailbox`, `NewMessage`, `Content`, `FlagChange`, `FlagOptions`, `ListOptions`, `ChangesOptions` | what a store takes |
| `StoreError`, `StoreErrorCode` | `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID`, `CANNOT_CALCULATE_CHANGES` |
| `blobIdOf(content)` | the SHA-256 of a message's bytes, in hex |
| `normalizeFlag(flag)`, `SYSTEM_FLAGS` | a flag as stores keep it: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`, and keywords in lowercase |
| `MAILBOX_ROLES` | `inbox`, `drafts`, `sent`, `trash`, `junk`, `archive` |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/store/docs/guide.md): accounts, mailboxes and roles, messages and their mailboxes, UIDs and modseqs, flags, changes, and writing a store of your own.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/store/docs/troubleshooting.md): every `StoreError`, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/store/docs/roadmap.md): what is coming, and what is not planned.
