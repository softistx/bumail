# @bumail/store

Where a mail server keeps its mail: accounts, mailboxes, messages, flags,
UIDs and modseqs behind one contract, `MailStore`, with a memory store,
a `bun:sqlite` store on disk and a PostgreSQL store for several server
instances. Every store answers the contract the same way, so the SMTP
server, IMAP and JMAP never know which one they were given. No
dependency.

**Bun only**: it hashes content with `Bun.CryptoHasher`, the store on
disk uses `bun:sqlite` and the PostgreSQL store `Bun.sql`, so it runs on
Bun 1.4.2 or later, not on Node.

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
const message = await store.addMessage(account.id, inbox.id, { content: raw }); // or a ReadableStream
message.mailboxes[0]?.uid; // 1, then 2, 3… — never reused in this mailbox
await store.setFlags(account.id, [message.id], { add: ['\\Seen'] });

const content = await store.readContent(account.id, message.blobId); // a Blob
await content?.text();
```

Every method but the account's own takes the account first, and acts
only in it: another account's mailbox is `NOT_FOUND`, its message lands in
`notFound`, and `getMessage` or `getMailbox` returns `undefined` for it.
Content is kept per account too: `readContent` reads only the given
account's blobs, so the same bytes elsewhere are another blob, and a blob
id from someone else's mail gives `undefined`. The Blob is valid until its
message leaves the account (destroyed, or its last mailbox removed):
reading it afterwards may fail.

## Messages and mailboxes

A message is one message for its whole life, as JMAP sees it: one id, a
thread, its own flags, in one mailbox or several. IMAP sees it through each
mailbox it is in, with a UID there.

```ts
const archive = await store.createMailbox(account.id, { name: 'Archive', role: 'archive' });
await store.moveMessages(account.id, [message.id], inbox.id, archive.id); // same id, new UID in Archive
await store.linkMessages(account.id, [message.id], inbox.id); // in both now
await store.copyMessages(account.id, [message.id], archive.id); // IMAP COPY: a new message
const { expunged, notFound } = await store.removeMessages(account.id, [message.id], inbox.id);
// out of INBOX, still in Archive; an id already gone lands in notFound

await store.listAccountMessages(account.id, { offset: 0, limit: 50 }); // every mailbox
await store.setSubscribed(account.id, archive.id, false); // IMAP UNSUBSCRIBE
```

A call given several ids acts on those that exist and lists the others in
`notFound`, rather than failing for all of them.

## Keeping in sync

Every change in an account takes the account's next **modseq**. Ask for
what changed since the last one you saw:

```ts
let since = 0;
const changes = await store.messageChanges(account.id, since, { limit: 500 });
changes.created; changes.updated; changes.destroyed; // message ids
changes.expunged; // { messageId, mailboxId, uid, modseq } for IMAP's VANISHED
since = changes.modseq; // next time; ask again at once while changes.hasMore

// One mailbox only, for an IMAP session on it: moved in is created, moved out destroyed
await store.messageChanges(account.id, since, { mailboxId: inbox.id });
```

`limit` counts the entries of all four lists; `mailboxChanges` pages the
same way over its three. This is what IMAP's CONDSTORE and QRESYNC
(RFC 7162) and JMAP's `/changes` need. `since` 0 is always answered,
with the account's whole state (or, with `mailboxId`, that mailbox's),
so it is also where to start over after `CANNOT_CALCULATE_CHANGES`.

## On disk: `@bumail/store/sqlite`

`SqliteMailStore` answers the same contract in one directory, with Bun's
own SQLite: nothing to install, and code written against `MailStore` does
not change.

```ts
import { SqliteMailStore } from '@bumail/store/sqlite';

const store = SqliteMailStore.open({ directory: '/var/lib/bumail/mail' }); // created if need be
const account = await store.createAccount('mary@example.net');
// … every MailStore method, as above

store.close(); // lets go of the lock; closing twice is fine
```

- **One process per database**: it holds an EXCLUSIVE lock until `close()`,
  so a second `open` of the directory, here or in another process, is
  refused.
- **Durable**: every write is flushed to disk before it is acknowledged.
- **Blobs on disk**: message content lives under `blobs/`, one file per
  SHA-256, written once however many messages share it.
- **Private**: directories are made 0700 and files 0600.
- **Lazy content**: the Blob `readContent` returns reads its file when you
  read it, and is valid until its message leaves the account.
- `maxTombstones` bounds how many removals an account remembers, as for
  `MemoryMailStore`; the default is all of them.

The main entry never imports `bun:sqlite`: only `@bumail/store/sqlite`
does. Layout, durability, backups and migrations are in the
[guide](https://github.com/softistx/bumail/blob/develop/packages/store/docs/guide.md#the-bunsqlite-store).

## Several instances: `@bumail/store/postgres`

`PostgresMailStore` answers the same contract on PostgreSQL, through
Bun's own `Bun.sql`: no driver to install. Every instance of the server
opens a store on the same database, and they share the mail.

```ts
import { PostgresMailStore } from '@bumail/store/postgres';

const sql = new Bun.SQL({ url: Bun.env['DATABASE_URL'], max: 10 });
const store = PostgresMailStore.open({ sql }); // or { sql: 'postgres://…' }
await store.migrate(); // makes the tables; the first call does it otherwise
const account = await store.createAccount('mary@example.net');
// … every MailStore method, as above

await store.close(); // closes only a client it opened from a URL
```

- **Several instances**: every write locks its account's row first, so
  the writes of an account run in turn, from any instance: modseqs and
  UIDs are given once each, in order, and a client following the changes
  never misses one. Different accounts write side by side.
- **A narrower role for the servers**: once `migrate()` ran with the
  owner's role, a role with only `SELECT`, `INSERT`, `UPDATE` and
  `DELETE` on the tables runs the store.
- **Content in the database**: `bytea`, once per distinct bytes in an
  account, dropped with its last message.
- **Pages in the database**: the changes send only the entries up to the
  page's end, and `listAccountMessages` only the page asked for.
- `tablePrefix` (`bumail_store_` by default) names the tables. It must
  never be the same as a `@bumail/queue/postgres` queue's (by default
  `bumail_queue_`) or any other package's: a store that finds another's
  `<prefix>schema` refuses it, `INVALID`. `maxTombstones` works as for
  the other stores. A login or a mailbox
  name holding a NUL or a lone surrogate, which PostgreSQL cannot keep
  as given, is `INVALID`, and so is a login over 1024 bytes of UTF-8.

Tables, roles, migrations, durability and how the instances share the
work are in the
[guide](https://github.com/softistx/bumail/blob/develop/packages/store/docs/guide.md#the-postgresql-store).

## Writing a store

A store implements `MailStore`, throws `StoreError` with the contract's
codes, and behaves as the contract says: every call all or nothing, and
nothing it returns shared with what it keeps. Content is addressed by its
SHA-256, so the same bytes have the same id in every store: `blobIdOf`
hashes bytes already in hand, and `readBlob` reads content given as a
stream chunk by chunk, hashing and counting as it goes.

The contract's specs, `describeMailStore`, which every store here runs, are
internal for now: a store written outside this package cannot run them
yet. The interface may grow in a 0.x minor version, which such a store
follows.

## API

| import | what it holds |
| --- | --- |
| `@bumail/store` | the contract, `MemoryMailStore` and the helpers; no `bun:` import |
| `@bumail/store/sqlite` | `SqliteMailStore`, on `bun:sqlite` and files |
| `@bumail/store/postgres` | `PostgresMailStore`, on PostgreSQL through `Bun.sql` |

| export | |
| --- | --- |
| `MailStore` | the contract: accounts, mailboxes, messages, flags, changes |
| `MemoryMailStore`, `MemoryMailStoreOptions` | the contract in memory; `maxTombstones` bounds what it remembers of removals |
| `SqliteMailStore`, `SqliteMailStoreOptions` | from `@bumail/store/sqlite`: the contract on `bun:sqlite`, opened with `SqliteMailStore.open({ directory, maxTombstones? })` and let go of with `close()` |
| `PostgresMailStore`, `PostgresMailStoreOptions`, `PostgresClient`, `PostgresQueryable` | from `@bumail/store/postgres`: the contract on PostgreSQL through `Bun.sql`, for several instances, opened with `PostgresMailStore.open({ sql, tablePrefix?, maxTombstones? })`, its tables made by `migrate()`, and closed with `close()`; `PostgresClient` is the shape of the client it takes, which a `Bun.SQL` fits |
| `Account`, `Mailbox`, `MailboxRole`, `Message`, `Membership`, `MailboxEntry`, `Expunged` | what a store returns |
| `MessagesResult`, `FlagResult`, `ExpungeResult`, `MessagePage` | what the calls on several messages return: the messages or expunges, and `notFound`; a page of `listAccountMessages` |
| `MessageChanges`, `MailboxChanges` | what the changes return |
| `NewMailbox`, `MailboxRename`, `NewMessage`, `Content`, `FlagChange`, `FlagOptions`, `ListOptions`, `AccountListOptions`, `ChangesOptions`, `MessageChangesOptions` | what a store takes |
| `StoreError`, `StoreErrorCode` | `NOT_FOUND`, `ALREADY_EXISTS`, `INVALID`, `CANNOT_CALCULATE_CHANGES` |
| `blobIdOf(bytes)` | the SHA-256 of a message's bytes, in hex; takes a `Uint8Array` only |
| `readBlob(content)`, `ReadBlob` | content read to its end: `{ blobId, size, blob }`, a stream hashed chunk by chunk |
| `normalizeFlag(flag)`, `SYSTEM_FLAGS` | a flag as stores keep it: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`, and keywords as written, compared without case |
| `MAILBOX_ROLES`, `isMailboxRole(value)` | `inbox`, `all`, `archive`, `drafts`, `flagged`, `important`, `junk`, `sent`, `trash`; whether a string is one. A role the IANA registry adds comes in a minor release: a `switch` keeps a `default` |

## Documentation

These pages ship in the package, under `docs/`.

- [Index](https://github.com/softistx/bumail/blob/develop/packages/store/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/store/docs/guide.md): accounts, mailboxes and roles, messages and their mailboxes, UIDs and modseqs, flags, changes, the `bun:sqlite` store, the PostgreSQL store, and writing a store of your own.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/store/docs/troubleshooting.md): every `StoreError`, the `bun:sqlite` and PostgreSQL stores' errors, and what to do about them.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/store/docs/roadmap.md): what is coming, and what is not planned.
