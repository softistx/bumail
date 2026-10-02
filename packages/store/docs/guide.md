# Guide

- [The contract](#the-contract)
- [Accounts](#accounts)
- [Mailboxes](#mailboxes)
- [Messages](#messages)
- [UIDs and modseqs](#uids-and-modseqs)
- [Flags](#flags)
- [Copying, linking, moving, removing](#copying-linking-moving-removing)
- [Changes](#changes)
- [Writing a store](#writing-a-store)

## The contract

`MailStore` is an interface; `MemoryMailStore` is its first answer, and a
`bun:sqlite` store is coming. Code that keeps mail takes a `MailStore`:

```ts
import type { MailStore } from '@bumail/store';

async function deliver(store: MailStore, login: string, raw: ReadableStream<Uint8Array>) {
	const account = await store.findAccount(login);
	if (!account) return false;
	const inbox = await store.findMailbox(account.id, 'inbox');
	if (!inbox) return false;
	await store.addMessage(inbox.id, { content: raw });
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
- **Each id once.** A method given a list of ids takes each one once,
  however often it is listed.
- **Copies.** What a store returns is yours: changing a returned `Date`,
  array or object, or the `Date` or bytes you gave it, never changes what
  it keeps.
- **Errors.** Every refusal is a `StoreError` with a `code`: `NOT_FOUND`,
  `ALREADY_EXISTS`, `INVALID` or `CANNOT_CALCULATE_CHANGES`. A method
  given an unknown account id throws `NOT_FOUND`; `getAccount`,
  `getMailbox`, `getMessage`, `findAccount` and `readContent` return
  `undefined` instead.

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
await store.renameMailbox(clients.id, 'Customers'); // and to the top, since no parent is given
await store.deleteMailbox(work.id); // INVALID: it has a child
await store.deleteMailbox(clients.id, { removeMessages: true });
```

- A mailbox has a `name`, an optional `parentId` for a hierarchy, and an
  optional `role`: `inbox`, `drafts`, `sent`, `trash`, `junk`, `archive`
  (RFC 6154, RFC 8621). A role is unique in its account.
- A name is unique under its parent, is trimmed, holds 1 to 255
  characters, no control character, and **no `/`**: the hierarchy is
  `parentId`, so the IMAP layer can use `/` as its delimiter.
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
  step, and a message in no other mailbox is destroyed.

## Messages

```ts
const message = await store.addMessage(inbox.id, {
	content: raw, // a Uint8Array, or a ReadableStream<Uint8Array>
	flags: ['\\Seen'],
	receivedAt: new Date(),
});
// { id, accountId, blobId, size, flags, receivedAt, createdModseq, modseq,
//   mailboxes: [{ mailboxId, uid, modseq }] }

await store.listMessages(inbox.id); // [{ uid, message }] in UID order
await store.listMessages(inbox.id, { fromUid: 120 });
await store.listMessages(inbox.id, { changedSince: 4711 }); // RFC 7162 CHANGEDSINCE

const blob = await store.readContent(message.blobId);
await blob?.slice(0, 1024).text(); // a range
blob?.stream(); // or all of it, as a stream
```

A message is one message for its life — JMAP's Email: one `id`, its own
`flags`, and the `mailboxes` it is in, never none. IMAP sees it in each
mailbox through a `MailboxEntry`, with its UID there; its MODSEQ is
`message.modseq` in every mailbox.

Content given as a stream is read to its end, hashed and counted as it
goes. Content is kept once per distinct bytes: `blobId` is the SHA-256 of
the content in hex, shared by equal contents and by copies, and dropped
when no message uses it any more.

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
await store.setFlags([message.id], { add: ['\\Flagged'], remove: ['\\Seen'] });
await store.setFlags([message.id], { set: ['$Forwarded'] }); // replaces every flag

// RFC 7162 STORE (UNCHANGEDSINCE 4711)
const { messages, modified } = await store.setFlags(ids, { add: ['\\Deleted'] }, { unchangedSince: 4711 });
```

- A flag is a **system flag** — `\Seen`, `\Answered`, `\Flagged`,
  `\Deleted`, `\Draft`, in any case, stored in this case — or a
  **keyword**: printable ASCII without white space, `(`, `)`, `{`, `%`,
  `*`, `"`, `\` or `]`, 1 to 255 characters (RFC 9051 §9, RFC 8621
  §4.1.1). Keywords are stored in **lowercase**, since IMAP and JMAP both
  compare them without case: `$Junk` and `$junk` are one keyword.
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
await store.copyMessages([message.id], archive.id); // new messages
await store.linkMessages([message.id], archive.id); // the same message, in one more mailbox
await store.moveMessages([message.id], inbox.id, archive.id); // leaves INBOX, joins Archive
await store.removeMessages([message.id], archive.id); // out of Archive; in none left, destroyed
await store.destroyMessages([message.id]); // out of every mailbox
```

- **Copy** is IMAP COPY (RFC 9051 §6.4.7): a new message with a new id,
  the same content, flags and date, and flags of its own from then on —
  setting `\Seen` on the copy leaves the original unseen, as an IMAP
  client expects of a copy. The blob is shared, not duplicated.
- **Link** is JMAP's `mailboxIds`: the same message, one more mailbox, a
  new UID there. A message already in that mailbox is unchanged.
- **Move** is IMAP MOVE (RFC 6851): the message keeps its id, gets a new
  UID in the target, and leaves an expunge in the source. A message
  already in the target keeps its UID there.
- **Remove** is IMAP EXPUNGE: out of one mailbox. **Destroy** is JMAP's
  `Email/set destroy`: out of all of them. A message in no mailbox is
  destroyed, and its blob dropped once nothing uses it.

Messages never leave their account: a copy, link or move to another
account's mailbox is `INVALID`.

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
const mailboxes = await store.mailboxChanges(account.id, 0);
```

- `created`, `updated` and `destroyed` are ids, as JMAP's `/changes`
  returns them (RFC 8620 §5.2). `updated` is a message whose flags or
  mailboxes changed. A message created and destroyed since `since` is in
  neither list.
- `expunged` lists every message that left a mailbox in the same range,
  with its UID there: IMAP's `VANISHED (EARLIER)` (RFC 7162 §3.2.10).
- `limit` caps the ids returned (JMAP's `maxChanges`); `hasMore` says to
  ask again from the returned `modseq`.
- `mailboxChanges` lists mailboxes created, deleted, renamed or moved,
  and those whose messages changed, since their counts did.
- `since` is 0 or a modseq the account gave. One the store no longer
  remembers is `CANNOT_CALCULATE_CHANGES`: start again from 0 (JMAP's
  `cannotCalculateChanges`, a full QRESYNC). `MemoryMailStore` remembers
  every removal unless given `maxTombstones`.

## Writing a store

A store of your own implements `MailStore` and:

- throws `StoreError` with the codes above, for the same causes;
- does each call all or nothing, and as if alone: a `bun:sqlite` store
  runs each in a transaction, with UNIQUE indexes for logins, names and
  roles;
- returns copies, never what it keeps;
- addresses content with `blobIdOf(content)`, and keeps flags with
  `normalizeFlag`;
- follows the UID and modseq rules above.

The contract's specs live next to the stores in this package and run
against each of them; a store added here runs them too.
