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

const message = await store.addMessage(inbox.id, { content: raw }); // raw: Uint8Array
message.uid; // 1, then 2, 3… — never reused in this mailbox
await store.setFlags([message.id], { add: ['\\Seen'] });

const content = await store.readContent(message.blobId); // the bytes back
```

## Keeping in sync

Every change in an account — a message added, its flags changed, a message
removed — takes the account's next **modseq**. Ask for what changed since
the last one you saw:

```ts
let since = 0;
const { modseq, messages, removed } = await store.changes(account.id, since);
since = modseq; // next time
```

This is what IMAP's CONDSTORE and QRESYNC (RFC 7162) and JMAP's `/changes`
need.

## Writing a store

A store implements `MailStore`, throws `StoreError` with the contract's
codes, and passes the contract's specs. Content is addressed by
`blobIdOf(content)`, its SHA-256, so the same bytes have the same id in
every store.

## API

| export | |
| --- | --- |
| `MailStore` | the contract: accounts, mailboxes, messages, flags, `changes` |
| `MemoryMailStore` | the contract in memory |
| `Account`, `Mailbox`, `MailboxRole`, `Message`, `Removed`, `Changes` | what a store returns |
| `NewMailbox`, `NewMessage`, `FlagChange` | what a store takes |
| `StoreError`, `StoreErrorCode` | `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID` |
| `blobIdOf(content)` | the SHA-256 of a message's bytes, in hex |
| `normalizeFlag(flag)`, `SYSTEM_FLAGS` | a flag as stores keep it: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`, and keywords |

## Documentation

- [Guide](https://github.com/softistx/bumail/blob/develop/packages/store/docs/guide.md): accounts, mailboxes and roles, UIDs and modseqs, flags, copies and moves, changes, and writing a store of your own.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/store/docs/troubleshooting.md): every `StoreError`, and what to do about it.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/store/docs/roadmap.md): what is coming, and what is not planned.
