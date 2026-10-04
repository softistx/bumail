# Guide

- [The contract](#the-contract)
- [Accounts](#accounts)
- [Mailboxes](#mailboxes)
- [Messages](#messages)
- [UIDs and modseqs](#uids-and-modseqs)
- [Flags](#flags)
- [Copying, linking, moving, removing](#copying-linking-moving-removing)
- [Changes](#changes)
- [The bun:sqlite store](#the-bunsqlite-store)
- [The PostgreSQL store](#the-postgresql-store)
- [Writing a store](#writing-a-store)

## The contract

`MailStore` is an interface; `MemoryMailStore` answers it in memory,
`SqliteMailStore`, from `@bumail/store/sqlite`, on disk, and
`PostgresMailStore`, from `@bumail/store/postgres`, on a PostgreSQL that
several server instances share. Code that keeps mail takes a `MailStore`:

```ts
import type { MailStore } from '@bumail/store';

async function deliver(store: MailStore, login: string, raw: ReadableStream<Uint8Array>) {
	const account = await store.findAccount(login);
	if (!account) return false;
	const inbox = await store.findMailbox(account.id, 'inbox');
	if (!inbox) return false;
	await store.addMessage(account.id, inbox.id, { content: raw });
	return true;
}
```

What every store promises:

- **Asynchronous.** Every method returns a promise, so a store may live
  across a network.
- **All or nothing.** A call that rejects changed nothing — no flag, no
  modseq. Concurrent calls behave as if they ran one after the other: two
  `createAccount('a@x')` at once give one account and one
  `ALREADY_EXISTS`.
- **Each id once, and the missing ones named.** A method given a list of
  ids takes each one once, however often it is listed. An id that names
  no message of the account — destroyed by another session meanwhile,
  never there, or another account's — is skipped and listed in the
  result's `notFound`; the others are still acted on, as IMAP does with
  the messages that remain and JMAP's `notFound`. A malformed argument
  (`INVALID`) still fails the whole call.
- **Copies.** What a store returns is yours: changing a returned `Date`,
  array or object, or the `Date` or bytes you gave it, never changes what
  it keeps.
- **One account at a time.** Every method but the account's own takes
  the account it acts in, first: `getMessage(accountId, id)`,
  `setFlags(accountId, ids, change)`. Another account's mailbox or message
  is treated as an id that names nothing, and never acted on: a mailbox id
  is `NOT_FOUND`, a message id lands in `notFound`, and `getMailbox`,
  `getMessage` and `readContent` return `undefined`. An id is no key to
  someone else's mail.
- **Errors.** Every refusal is a `StoreError` with a `code`: `NOT_FOUND`,
  `ALREADY_EXISTS`, `INVALID` or `CANNOT_CALCULATE_CHANGES` — never a
  `TypeError` from a wrong argument, nor a stream's own error. An unknown
  account id is `NOT_FOUND` for every method that takes one, `readContent`
  and the `get…` methods included; so is an unknown mailbox id. An
  unknown mailbox or message id given to `getMailbox` or `getMessage`,
  and an unknown blob id given to `readContent`, return `undefined`;
  `getAccount` and `findAccount` return `undefined` for an unknown
  account.
- **Growth.** In 0.x, a minor version may add methods to `MailStore` and
  fields to what it returns. A store written outside this package follows
  those versions.

## Accounts

```ts
const account = await store.createAccount('mary@example.net');
await store.findAccount('Mary@Example.NET'); // the same account
await store.deleteAccount(account.id); // its mailboxes and messages too
```

The login is unique, compared case-insensitively, and kept as given.

## Mailboxes

```ts
const inbox = await store.createMailbox(account.id, { name: 'INBOX', role: 'inbox' });
const work = await store.createMailbox(account.id, { name: 'Work' });
const clients = await store.createMailbox(account.id, { name: 'Clients', parentId: work.id });

await store.findMailbox(account.id, 'inbox'); // by role
await store.deleteMailbox(account.id, work.id); // INVALID: it has a child
await store.renameMailbox(account.id, clients.id, { name: 'Customers' }); // still under Work
await store.renameMailbox(account.id, clients.id, { parentId: null }); // to the top
await store.deleteMailbox(account.id, work.id); // now it has none
await store.deleteMailbox(account.id, clients.id, { removeMessages: true });

const lists = await store.createMailbox(account.id, { name: 'Lists', isSubscribed: false });
await store.setSubscribed(account.id, lists.id, true); // IMAP SUBSCRIBE
```

- A mailbox has a `name`, an optional `parentId` for a hierarchy, and an
  optional `role`: `inbox`, and the special uses of the IANA registry
  JMAP draws on (RFC 8621 §2) — `all`, `archive`, `drafts`, `flagged`,
  `junk`, `sent`, `trash` (RFC 6154) and `important` (RFC 8457). A role is
  unique in its account. `isMailboxRole(value)` checks one read from
  outside. `MailboxRole` is a closed union of these: a role the registry
  adds later comes in a minor release, so a `switch` over a role keeps a
  `default` case.
- `isSubscribed` is IMAP's subscription (RFC 9051 §6.3.7) and JMAP's
  property of that name: `true` unless created otherwise, changed with
  `setSubscribed`, which takes a modseq like any change of the mailbox.
- A name is unique under its parent, is trimmed, holds 1 to 255
  characters, no control character, and **no `/`**: the hierarchy is
  `parentId`, so the IMAP layer can use `/` as its delimiter.
- `renameMailbox(accountId, id, { name?, parentId? })` takes at least one
  of the two, changes what it is given and keeps the rest, like JMAP's
  `Mailbox/set`: `parentId: null` moves the mailbox to the top. A change
  with neither field does not compile, and is `INVALID` from JavaScript.
  The mailbox keeps its id, role, subscription, UIDVALIDITY and messages.
- `findMailbox` with anything that is not a role, `undefined` included,
  is `INVALID`, as `createMailbox` is.
- **`INBOX`** at the top is case-insensitive (RFC 9051 §5.1): `inbox` or
  `Inbox` there is stored as `INBOX`, and is the same name. Under a parent
  it is an ordinary name.
- **A rename keeps the role.** Renaming the `inbox` mailbox renames it and
  it stays the inbox. IMAP's `RENAME INBOX`, which moves the messages to a
  new mailbox and leaves INBOX empty (RFC 9051 §6.3.6), is the IMAP
  layer's: `createMailbox`, then `moveMessages`.
- `uidValidity` is fixed for the mailbox's life and never given twice:
  a mailbox deleted and created again under the same name gets a new one.
  `uidNext`, `highestModseq`, `messages` and `unseen` are counted when you
  read the mailbox.
- `deleteMailbox` refuses a mailbox with children, and one with messages
  unless `removeMessages` is set; then it removes them from it in the same
  step, and a message in no other mailbox is destroyed. **A limit**: IMAP
  lets a server delete a mailbox with children and keep its name as
  `\Noselect` (RFC 9051 §6.3.4); this store keeps no such name, so the
  IMAP layer deletes or moves the children first.

## Messages

```ts
const message = await store.addMessage(account.id, inbox.id, {
	content: raw, // a Uint8Array, or a ReadableStream<Uint8Array>
	flags: ['\\Seen'],
	receivedAt: new Date(),
	threadId: original.threadId, // optional: a thread of its own by default
});
// { id, accountId, threadId, blobId, size, flags, receivedAt, createdModseq,
//   modseq, mailboxes: [{ mailboxId, uid, modseq }] }

await store.listMessages(account.id, inbox.id); // [{ uid, message }] in UID order
await store.listMessages(account.id, inbox.id, { fromUid: 120 });
await store.listMessages(account.id, inbox.id, { changedSince: 4711 }); // RFC 7162 CHANGEDSINCE
await store.listAccountMessages(account.id, { offset: 0, limit: 50 }); // { messages, total }

const blob = await store.readContent(account.id, message.blobId);
await blob?.slice(0, 1024).text(); // a range
blob?.stream(); // or all of it, as a stream
```

A message is one message for its life — JMAP's Email: one `id`, its own
`flags`, and the `mailboxes` it is in, never none. IMAP sees it in each
mailbox through a `MailboxEntry`, with its UID there; its MODSEQ is
`message.modseq` in every mailbox.

- **Threads.** `threadId` is JMAP's (RFC 8621 §4.1.1): the message's own
  id unless `addMessage` was given one — the `threadId` of the message it
  replies to, say. It is a non-empty string of printable ASCII without
  spaces, at most 255 characters, and fixed for the message's life; a copy
  keeps it. The store does not work threads out: whoever adds the message
  does, from its headers.
- **The whole account.** `listAccountMessages` lists every message of the
  account, in all its mailboxes, oldest added first, a page at a time with
  `offset` and `limit`; `total` counts them all. It is the start of JMAP's
  `Email/query`; searching and sorting come later.
- **Content.** Content given as a stream is read to its end, hashed and
  counted as it goes. A stream that fails, or yields something other than
  `Uint8Array` chunks, is cancelled, and nothing is added (`INVALID`); a
  stream another reader already holds (`stream.locked`) is `INVALID` too.
  Content is kept once per distinct bytes **in an account**: `blobId` is
  the SHA-256 of the content in hex, shared by equal contents and by
  copies in the account, and dropped when no message of the account uses
  it any more. `readContent` takes the account and reads only that
  account's blobs: the same bytes in another account are another blob, so
  a blob id from someone else's mail gives `undefined`. The Blob it returns
  is valid until its message leaves the account (destroyed, or its last
  mailbox removed); reading it afterwards may fail, so read it before.

The store does not parse a message: it keeps bytes. Parse them with
`@bumail/mime` when you need headers.

## UIDs and modseqs

- **UIDs** ascend strictly within a mailbox and are never reused, even
  after a removal (RFC 9051 §2.3.1.1). A mailbox past UID 4294967295 takes
  no more messages.
- **Modseqs** count the changes of the whole **account**: an add, a flag
  change, a message joining or leaving a mailbox, a mailbox created,
  renamed or deleted each take the next one, and no modseq is shared by
  two messages. A message's `modseq` is its last change.
- A mailbox's `highestModseq` is the last modseq of any of its messages,
  those that left it included, so it ascends as RFC 7162 needs. It is at
  least 1: creating the mailbox takes a modseq.

## Flags

```ts
await store.setFlags(account.id, [message.id], { add: ['\\Flagged'], remove: ['\\Seen'] });
await store.setFlags(account.id, [message.id], { set: ['$Forwarded'] }); // replaces every flag

// RFC 7162 STORE (UNCHANGEDSINCE 4711)
const { messages, modified } = await store.setFlags(account.id, ids, { add: ['\\Deleted'] }, { unchangedSince: 4711 });
```

- A flag is a **system flag** — `\Seen`, `\Answered`, `\Flagged`,
  `\Deleted`, `\Draft`, in any case, stored in this case — or a
  **keyword**: printable ASCII without white space, `(`, `)`, `{`, `%`,
  `*`, `"`, `\` or `]`, 1 to 255 characters (RFC 9051 §9, RFC 8621
  §4.1.1). IMAP and JMAP compare keywords without case, so `$Junk` and
  `$junk` are one keyword: a message never holds both, and `add`, `remove`
  and `set` match them without case. A keyword keeps the case it was
  **first stored** with — clients look for the one they set, `$Forwarded`,
  `$MDNSent`, `NonJunk` — so adding `$junk` to a message with `$Junk`
  changes nothing. Flags sort without case.
  `\Recent`, gone in IMAP4rev2, is `INVALID`.
- Flags belong to the message, so a flag set through one mailbox shows in
  every mailbox it is in. Flags come back sorted. A change that changes
  nothing takes no modseq.
- With `unchangedSince`, a message changed after that modseq is left alone
  and its id listed in `modified`, the others changed: RFC 7162's
  conditional STORE, checked and applied in one step.

## Copying, linking, moving, removing

```ts
const archive = await store.createMailbox(account.id, { name: 'Archive', role: 'archive' });
const { messages: [copy] } = await store.copyMessages(account.id, [message.id], archive.id); // a new message
await store.linkMessages(account.id, [message.id], archive.id); // the same message, in one more mailbox
await store.moveMessages(account.id, [message.id], inbox.id, archive.id); // leaves INBOX; keeps its UID in Archive
await store.removeMessages(account.id, [message.id], archive.id); // out of Archive; in none left, destroyed
if (copy) await store.destroyMessages(account.id, [copy.id]); // out of every mailbox
```

- **Copy** is IMAP COPY (RFC 9051 §6.4.7): a new message with a new id,
  the same content, flags and date, and flags of its own from then on —
  setting `\Seen` on the copy leaves the original unseen, as an IMAP
  client expects of a copy. The blob is shared, not duplicated.
- **Link** is JMAP's `mailboxIds`: the same message, one more mailbox, a
  new UID there. A message already in that mailbox is unchanged.
- **Move** is IMAP MOVE (RFC 6851): the message keeps its id, gets a new
  UID in the target, and leaves an expunge in the source. A message
  already in the target — linked there before — keeps the UID it has
  there, which is below the target's `uidNext`: a `COPYUID` built from the
  result names that UID, not a new one.
- **Remove** is IMAP EXPUNGE: out of one mailbox. **Destroy** is JMAP's
  `Email/set destroy`: out of all of them. A message in no mailbox is
  destroyed, and its blob dropped once nothing uses it.

Each returns what it did and the ids it skipped:

```ts
const { messages, notFound } = await store.moveMessages(account.id, ids, inbox.id, archive.id);
const { expunged, notFound: gone } = await store.removeMessages(account.id, ids, inbox.id);
// expunged: [{ messageId, mailboxId, uid, modseq }]
```

`moveMessages` and `removeMessages` count a message that is not in the
mailbox it should leave as not found. Messages never leave their account:
another account's message is in `notFound`, and another account's mailbox
is `NOT_FOUND`, so nothing moves between accounts.

## Changes

```ts
let since = 0;
for (;;) {
	const changes = await store.messageChanges(account.id, since, { limit: 500 });
	// changes.created, changes.updated, changes.destroyed: message ids
	// changes.expunged: [{ messageId, mailboxId, uid, modseq }]
	since = changes.modseq;
	if (!changes.hasMore) break;
}
const inInbox = await store.messageChanges(account.id, since, { mailboxId: inbox.id });
const mailboxes = await store.mailboxChanges(account.id, 0);
```

- `created`, `updated` and `destroyed` are ids, as JMAP's `/changes`
  returns them (RFC 8620 §5.2). `updated` is a message whose flags or
  mailboxes changed. A message created and destroyed since `since` is in
  neither list.
- `expunged` lists every message that left a mailbox in the same range,
  with its UID there: IMAP's `VANISHED (EARLIER)` (RFC 7162 §3.2.10). It
  lists every UID expunged after `since`, even one that came into its
  mailbox after `since`, as RFC 7162 §3.2.6 asks: a client may know it
  from a session in between, and ignores a UID it does not hold.
- `limit` caps the entries returned, `created`, `updated`, `destroyed`
  and `expunged` together (JMAP's `maxChanges`); `hasMore` says to ask
  again from the returned `modseq`. A page cuts by when each thing was
  created, for `created`, and by its last change otherwise, so a message
  created then changed again is `created` on the first page that reaches
  it and `updated` on a later one — RFC 8620 §5.2's intermediate states.
  A page never splits the changes of one modseq, so it holds more than
  `limit` only when one modseq alone has more, or, since 0, to reach the
  oldest `since` the store answers (below).
- `mailboxId` narrows the answer to one mailbox, for a client that holds
  only that one — an IMAP session on it, or a JMAP view of a folder. A
  message that came into it since `since` is `created`, even when the
  account had it before; one that was in it at `since` and left is
  `destroyed`, even when it is still in another mailbox; one that left
  and came back is `updated`; and `expunged` lists only its UIDs, every
  one expunged after `since` as above. Paging works the same, except
  that a `created` message sorts by its first coming in after `since`
  and a `destroyed` one by its first leaving after `since`. Sorted by
  its last coming in, a message could be passed by one page and called
  `updated` by the next. A mailbox the account does not have, or no
  longer has, is `NOT_FOUND`: after deleting a mailbox, a client drops
  what it held of it. A change in another mailbox counts too: linking a
  message elsewhere makes it `updated` here, since its mailboxes are part
  of it.
- Pages are intermediate states. Across pages, a message that left a
  mailbox and came back may be `created` for a client that already holds
  it, and one may be `destroyed` twice: treat `created` as add-or-replace,
  and ignore a `destroyed` id you do not hold. Following every page always
  ends at the current state.
- `mailboxChanges` lists mailboxes created, deleted, renamed or moved,
  and those whose messages changed, since their counts did.
- `since` is 0 or a modseq the account gave. One the store no longer
  remembers is `CANNOT_CALCULATE_CHANGES` (JMAP's `cannotCalculateChanges`,
  a full QRESYNC): ask again from 0. **Since 0 is always answered**, as the
  account's whole state: every message that exists is in `created`, and
  `destroyed` and `expunged` are empty, so whatever a client holds that is
  not in `created` is gone. A page since 0 never ends below the oldest
  `since` the store still answers, so its `hasMore` pages can always be
  asked for: it may go past `limit` to get there. `MemoryMailStore`,
  `SqliteMailStore` and `PostgresMailStore` remember every removal unless
  given `maxTombstones`.

## The bun:sqlite store

`SqliteMailStore`, from `@bumail/store/sqlite`, answers the same contract
on disk with Bun's own `bun:sqlite`, and runs the same contract specs as
`MemoryMailStore`. The main entry, `@bumail/store`, never imports
`bun:sqlite`: an app that uses only the memory store never loads it.

### Opening and closing

```ts
import type { MailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';

const sqlite = SqliteMailStore.open({ directory: '/var/lib/bumail/mail' });
const store: MailStore = sqlite; // what the rest of the server is given

process.on('SIGTERM', () => {
	sqlite.close();
	process.exit(0);
});
```

`open` is synchronous: it makes the directory and whichever of its parents
are missing, opens or creates `mail.sqlite`, brings its schema up to date,
and sweeps the blobs (below). Whatever goes wrong there is a `StoreError`
with the code `INVALID`, most often naming the directory (a missing
`directory`, a bad `maxTombstones` or a newer schema do not); see
[Troubleshooting](troubleshooting.md), its last group.

`close()` lets go of the database and of its lock, and may be called more
than once. Every method called after it rejects with `The store is closed`.
Within one process, close a store before opening its directory again; a
process that exits, or dies, lets go of the lock with it.

### The directory

```
/var/lib/bumail/mail/          0700
├── mail.sqlite                0600  accounts, mailboxes, messages, flags, changes
├── mail.sqlite-wal            0600  writes not yet copied into mail.sqlite
└── blobs/                     0700
    ├── 9c/                    0700  the first two hex digits of the hash
    │   └── 9c6c8eb5…d09       0600  the message's bytes, named by their SHA-256
    └── <uuid>.staging               content being written, gone once it is placed
```

The database runs in WAL mode, so `mail.sqlite-wal` sits beside it, and
may stay there after `close()`: it is part of the database. A blob holds
the exact bytes given to `addMessage`; the same bytes in an account are
written once, however many messages use them. Which account holds which
blob is in the database; a blob is removed once no account holds it.

### Durability

A call resolves only once what it changed is on disk:

- the database runs with `synchronous = FULL` and, on macOS,
  `fullfsync = ON`, so a commit flushes the drive's cache too: there a
  plain `fsync` leaves data in it. Linux ignores that PRAGMA;
- content is written to a `.staging` file and flushed, renamed to its
  hash and both its directories flushed, **before** the transaction that
  names it commits. A row never names a blob that is not on disk;
- a removal commits first and removes the blobs no account holds any more
  after it. A crash in between leaves a blob nobody names, never a row
  without its blob;
- a directory `open` makes, and the parent of each, is flushed too.

### Backups

The safest backup is of a **closed** store: copy `mail.sqlite`,
`mail.sqlite-wal` when it is there, and `blobs/`, together.

```sh
systemctl stop bumail
tar -C /var/lib/bumail -czf mail-$(date +%F).tar.gz mail
systemctl start bumail
```

A store that must stay open is backed up by a filesystem snapshot of the
whole directory at one instant (ZFS, Btrfs, LVM, an APFS snapshot), then
copied from the snapshot. Never copy `mail.sqlite` without its WAL: the
WAL holds committed writes not yet in the main file. A copy file by file
while the store runs can catch a message whose blob was removed between
the two. Restoring is putting the directory back, and opening it: blobs
no row names are swept, as below. `sqlite3 .backup` cannot read the
database while the store holds it: see Locking.

### Locking

One process opens a store, and in it one `SqliteMailStore`. `open` sets
`locking_mode = EXCLUSIVE` and takes a write lock it keeps until
`close()`, with `busy_timeout = 0`: a second `open` of the same directory,
in this process or another, fails at once with `it is already open`,
rather than waiting. Within the store, every call runs in one transaction
without awaiting, so concurrent calls never interleave. Several processes
that share mail need a store meant for that: [the PostgreSQL
store](#the-postgresql-store).

### The sweep on open

Opening removes what a crash left: the `.staging` files of a write that
never finished, and every blob no account holds — written for an add whose
transaction never committed, or left by a removal that died before its
unlink. It reads every shard under `blobs/`, so **opening takes longer as
the store grows**: open once at start-up, not per request. What cannot be
removed is left for the next open: a leftover blob is harmless, a store
that will not open is not.

### maxTombstones

```ts
const store = SqliteMailStore.open({ directory, maxTombstones: 10_000 });
```

As for `MemoryMailStore`: how many removals each account remembers for
`messageChanges` and `mailboxChanges`. Past it the oldest are forgotten,
and a `since` before them is `CANNOT_CALCULATE_CHANGES`. The default
remembers all of them, which grows the database for good. It is not kept
in the database: give it on every `open`. Lowering it forgets the excess
at the account's next removal. It must be an integer of at least 0, or
`Infinity`.

### Permissions

Mail is its owner's alone. The directories `open` makes are 0700, and the
database, its WAL and every blob are 0600, whatever the process's umask:
`open` sets the mode of a `mail.sqlite` and a WAL that exist already. A
directory that already exists keeps its mode; make it 0700 yourself, owned
by the user the server runs as.

### Migrations

The schema's version is the database's `PRAGMA user_version`. `open` runs
the migrations the database has not had, in one transaction: one that
fails leaves the database as it was. A database written by a newer
`@bumail/store`, with a higher `user_version` than this version knows, is
refused and left untouched, so downgrading the package never damages it:
upgrade again, or restore a backup taken before the upgrade.

## The PostgreSQL store

`PostgresMailStore`, from `@bumail/store/postgres`, answers the same
contract on PostgreSQL through Bun's own `Bun.sql`: there is no driver to
install and no peer to add. It is the store for a server that runs as
several instances: each opens a store on the same database, and they
share the mail. It runs the same contract specs as the other two, and
specs of its own for several instances on one database.

### Opening and closing

```ts
import type { MailStore } from '@bumail/store';
import { PostgresMailStore } from '@bumail/store/postgres';

const sql = new Bun.SQL({ url: Bun.env['DATABASE_URL'], max: 10 });
const postgres = PostgresMailStore.open({ sql });
await postgres.migrate(); // or let the first call do it
const store: MailStore = postgres;

process.on('SIGTERM', async () => {
	await postgres.close(); // closes only a client it opened itself
	await sql.close(); // yours
	process.exit(0);
});
```

- **`sql`** is a `Bun.SQL` client of yours — you size its pool and close
  it — or a `postgres://` (or `postgresql://`) URL, for which the store
  opens a client with Bun's defaults and closes it in `close()`. A
  `Bun.SQL` client for SQLite or MySQL is refused. It is typed by its
  shape, `PostgresClient` (`unsafe`, `begin` and `close`), the shape
  `@bumail/queue/postgres` takes too, so one client can serve both.
- **`tablePrefix`** names the tables: `bumail_store_` by default;
  lowercase letters, digits and underscores, starting with a letter or
  an underscore, 40 characters at most. It is written into the
  statements, never bound. The tables go in the connection's default
  schema (its `search_path`). **It must never be the prefix of a
  `@bumail/queue/postgres` queue, or of any other package**, on the same
  database: the queue's tables include a `<prefix>schema` and a
  `<prefix>messages`. The defaults differ (`bumail_queue_`). The store
  keeps its version in `<prefix>store_schema`, and its first migration
  refuses, `INVALID`, a `<prefix>schema` or any of its own tables
  already there, so a store opened second on a queue's prefix fails
  before it creates anything. A queue opened second on a store's prefix
  is the queue's to refuse.
- **`maxTombstones`**, as for the other stores (below).
- **Every call sets its isolation level**, whatever the client's
  sessions default to, so a client shared with code that defaults to
  `repeatable read` or `serializable` still serves the store: writes,
  creating an account and `migrate()`'s migration run at `READ COMMITTED`;
  reads, and `migrate()`'s version check, at `REPEATABLE READ, READ
  ONLY`. Every transaction a call opens sets its level, reads of a single
  row included.
- **Nothing connects at `open`**: a wrong option is refused there, as
  `INVALID`, and a database out of reach on the first call, as
  `INVALID`, `The PostgreSQL mail store cannot be set up: …`. A URL is
  never repeated in an error, and its password is masked should Bun's
  reason name it: always as `:password@`, and alone from 4 characters.
- `close()` may be called more than once. Every method called after it
  rejects with `The store is closed`.

### The tables

| table | what it holds |
| --- | --- |
| `<prefix>accounts` | an account a row: `id`, `name`, `login_key` (the login lower-cased, unique), `modseq` (the account's counter) and `floor` (the oldest `since` it still answers) |
| `<prefix>mailboxes` | `id`, `account_id`, `name`, `parent_id`, `role`, `is_subscribed`, `uid_validity` (unique), `uid_next`, `created_modseq`, `modseq` and `highest_modseq`. `<prefix>mailboxes_place` keeps a name unique under its parent, `<prefix>mailboxes_role` a role unique in its account |
| `<prefix>messages` | `id`, `account_id`, `thread_id`, `blob_id`, `size`, `flags` (`jsonb`, sorted), `received_at` (milliseconds since the epoch), `created_modseq` and `modseq`. `<prefix>messages_created` and `<prefix>messages_changed`, on `(account_id, created_modseq)` and `(account_id, modseq)`, serve the account's pages and its changes |
| `<prefix>memberships` | a message in a mailbox: `mailbox_id`, `uid` (the key, with the mailbox), `message_id` and `joined_modseq` |
| `<prefix>contents` | the bytes: `account_id`, `blob_id`, `uses` (how many of the account's messages use them), `size` and `content` (`bytea`) |
| `<prefix>tombstones` | what is gone, for the changes: a message destroyed, a mailbox deleted, a message that left a mailbox (with its UID there and when it had come in). `<prefix>tombstones_since` and `<prefix>tombstones_mailbox` serve the changes, for the account and for one mailbox |
| `<prefix>counters` | the last UIDVALIDITY given |
| `<prefix>store_schema` | the version: how many migrations ran |

They are the `bun:sqlite` store's tables, column for column, but for the
content. UIDs, modseqs, UIDVALIDITYs, sizes and times are `bigint`;
`uses` and the schema's `version` are `integer`. Deleting an account
deletes the rest with it (`ON DELETE CASCADE`). Every index and
constraint is named after the prefix, so a prefix of 40 still fits
PostgreSQL's 63 characters.

### Content

Message bytes are kept in the database, as `bytea` in
`<prefix>contents`, once per distinct bytes **in an account** — the same
bytes in two accounts are two rows, as the contract keeps blobs per
account — and dropped with the last message of the account that uses
them. Content given as a stream is read to its end first, hashed and
counted, before the transaction that keeps it starts, so no lock waits
on a slow stream; bytes the account already holds are not sent again.

`readContent` reads the bytes in one statement and returns a `Blob`
that holds them: it stays readable after its message is gone, and a
range of it (`blob.slice`) is cut in memory. So a message is in memory
whole while it is added or read, as in the memory store. A `bytea`
holds 1 GB at most, far above what a mail server takes. Keeping the
bytes apart from the database — on disk or in S3 — is the roadmap's blob
store; until then the database holds them, and its backups do too.

### Migrations and roles

`migrate()` makes the tables, or brings them to the last migration, in
one transaction; without it, the first call that needs them does. It
runs once per store. Instances starting together wait on one advisory
lock (`pg_advisory_xact_lock`), so each migration runs once. A migration
that fails is `INVALID`, and the next call tries again; tables written by
a newer version of the package are refused (`The database is at schema
version …, newer than this store's …`).

Tables already current are only read — `to_regclass` and their version,
with no lock and no DDL — so the role the servers run as needs `CREATE`
on the schema only to make them. Run `migrate()` once from a deploy step
with the owner's role, and give the servers a narrower one:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON
	bumail_store_accounts, bumail_store_mailboxes, bumail_store_messages,
	bumail_store_memberships, bumail_store_contents, bumail_store_tombstones,
	bumail_store_counters, bumail_store_store_schema
	TO bumail_server;
```

After an upgrade that adds a migration, run that step again before the
servers start: their role cannot make the change.

### Several instances

Every write runs in one transaction whose first statement locks its
account's row (`SELECT … FOR UPDATE`). So the writes of one account run
one after the other, whichever instance sends them, and those of
different accounts run side by side:

- **Modseqs.** The account's counter is that row's `modseq`: a write
  counts on from it and writes it back before it commits, under the lock.
  Each change takes the next value, none is given twice, and the writes
  of an account commit in the order of their modseqs — so a reader never
  sees a modseq before every smaller one is there.
- **UIDs.** A message joins a mailbox in one statement that takes the
  mailbox's `uid_next` and moves it on, under the same lock: UIDs ascend
  strictly in the order of their modseqs, and none is given again, even
  to two instances appending to one mailbox at once.
- **UIDVALIDITY** is the one value shared by every account: one row of
  `<prefix>counters`, moved on in the statement that reads it and locked
  until its transaction commits, never below the time in seconds. Two
  instances creating mailboxes at once wait on it in turn, briefly.
- **Thread ids** are the message's own id unless the caller gives one:
  nothing to allot.
- **Logins** are unique by an index, and created in one `INSERT … ON
  CONFLICT DO NOTHING`: of two instances creating one login, one gets
  `ALREADY_EXISTS`. Mailbox names and roles are checked under the
  account's lock.
- **Reads** of more than one statement — a mailbox and its counts, the
  changes and the modseq they end at — run in one `REPEATABLE READ, READ
  ONLY` transaction, so they agree with each other. With the commits in
  modseq order, following `messageChanges` from page to page while other
  instances write never misses a change.

A busy account's writes wait on each other: an IMAP client storing flags
while mail arrives for it takes turns. A write holds the lock for a few
statements per message it changes; content is read before the lock is
taken.

### Changes and pages in the database

`messageChanges` and `mailboxChanges` are worked out in the database: it
finds where the page ends and sends only the entries up to there, at
most the page and the entries of one more modseq. It still goes over
every change since `since` to find that end. `listAccountMessages` pages
with `LIMIT` and `OFFSET`, `listMessages` reads from `fromUid` with
`changedSince` in its statement, and a call given many ids looks them
all up in one statement. The answers are the memory store's, entry for entry and
in the same order: a spec runs random histories on both and compares
every answer.

### Durability

A call resolves once its transaction has committed, so what it changed
is as durable as the server makes a commit: with PostgreSQL's defaults
(`synchronous_commit = on`, `fsync = on`), on disk. A server that
acknowledges commits before they are flushed, or before a standby has
them, can lose the last of them in a crash, as for any application on
it. Back the store up as any database: `pg_dump` reads one consistent
snapshot, the content included, while the store runs.

### maxTombstones

```ts
const store = PostgresMailStore.open({ sql, maxTombstones: 10_000 });
```

As for the other stores: how many removals each account remembers for
`messageChanges` and `mailboxChanges`; past it the oldest are forgotten,
under the account's lock, and a `since` before them is
`CANNOT_CALCULATE_CHANGES`. It is not kept in the database: give every
instance the same.

### Text PostgreSQL cannot keep

PostgreSQL's `text` holds no NUL, and `Bun.sql` sends a lone surrogate
(half of a UTF-16 pair) as U+FFFD, which would keep, and match, other
text. So a login or a mailbox name holding either is `INVALID` here,
where the memory store keeps it; an id or a login to look up holding
either names nothing, as an id no row has. Logins and names read from
IMAP or JMAP are well-formed already.

### Pool size

Each call holds one connection for one statement or one short
transaction. `Bun.SQL`'s default pool of 10 connections is enough for an
instance; a call waits for a free connection rather than fail. Keep every
instance's pool, and the queue's when it shares the database, within the
server's `max_connections` (100 by default).

## Writing a store

A store of your own implements `MailStore` and:

- throws `StoreError` with the codes above, for the same causes;
- does each call all or nothing, and as if alone: a `bun:sqlite` store
  runs each in a transaction, with UNIQUE indexes for logins, names and
  roles; the PostgreSQL store runs each write in a transaction that
  locks its account first;
- returns copies, never what it keeps;
- keeps blobs per account, and addresses content by its SHA-256:
  `blobIdOf(bytes)` takes a `Uint8Array` only, so content given as a
  stream is hashed chunk by chunk — `readBlob(content)` does that, and
  returns `{ blobId, size, blob }`;
- keeps flags with `normalizeFlag`;
- follows the UID and modseq rules above;
- keeps, with each removal from a mailbox, the modseq at which the message
  had come into it — `messageChanges` with `mailboxId` needs it to tell a
  message that was there at `since` from one that came and went — and
  sorts its changes for paging as `messageChanges`'s JSDoc lays out: a
  `created` message by its creation, or in one mailbox by its first coming
  in after `since`, so no page lists an update for a message the client
  was never given.

```ts
import { readBlob } from '@bumail/store';

const { blobId, size, blob } = await readBlob(input.content); // INVALID on a bad stream
await Bun.write(`blobs/${account.id}/${blobId}`, blob);
```

The contract's specs, `describeMailStore`, live next to the stores in this
package and run against each of them; a store added here runs them too.
A store that forgets old removals also passes a factory for one that
remembers at most a given number, so the specs for the floor
(`CANNOT_CALCULATE_CHANGES`, and what since 0 still answers) run against
it as well.
They are internal for now: a store written outside the package cannot run
them yet. And it follows the 0.x minor versions, in which the interface
may grow.
