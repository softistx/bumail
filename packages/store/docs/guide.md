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
- `renameMailbox(accountId, id, { name?, parentId? })` changes what it is
  given and keeps the rest, like JMAP's `Mailbox/set`: `parentId: null`
  moves the mailbox to the top, and a change with neither field is
  `INVALID`. The mailbox keeps its id, role, subscription, UIDVALIDITY
  and messages.
- `findMailbox` with a string that is not a role is `INVALID`, as
  `createMailbox` is.
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
  a blob id from someone else's mail gives `undefined`.

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
const mailboxes = await store.mailboxChanges(account.id, 0);
```

- `created`, `updated` and `destroyed` are ids, as JMAP's `/changes`
  returns them (RFC 8620 §5.2). `updated` is a message whose flags or
  mailboxes changed. A message created and destroyed since `since` is in
  neither list.
- `expunged` lists every message that left a mailbox in the same range,
  with its UID there: IMAP's `VANISHED (EARLIER)` (RFC 7162 §3.2.10). It
  leaves out a UID that came into its mailbox after `since` — added,
  copied, linked or moved there, then gone again — since the client never
  saw it.
- `limit` caps the ids returned (JMAP's `maxChanges`); `hasMore` says to
  ask again from the returned `modseq`. A page cuts by when each thing was
  created, for `created`, and by its last change otherwise, so a message
  created then changed again is `created` on the first page that reaches
  it and `updated` on a later one — RFC 8620 §5.2's intermediate states.
  A page never splits the changes of one modseq, so it holds more than
  `limit` only when one modseq alone has more.
- `mailboxChanges` lists mailboxes created, deleted, renamed or moved,
  and those whose messages changed, since their counts did.
- `since` is 0 or a modseq the account gave. One the store no longer
  remembers is `CANNOT_CALCULATE_CHANGES` (JMAP's `cannotCalculateChanges`,
  a full QRESYNC): ask again from 0. **Since 0 is always answered**, as the
  account's whole state: every message that exists is in `created`, and
  `destroyed` and `expunged` are empty, so whatever a client holds that is
  not in `created` is gone. A page since 0 never ends below the oldest
  `since` the store still answers, so its `hasMore` pages can always be
  asked for: it may go past `limit` to get there. `MemoryMailStore`
  remembers every removal unless given `maxTombstones`.

## Writing a store

A store of your own implements `MailStore` and:

- throws `StoreError` with the codes above, for the same causes;
- does each call all or nothing, and as if alone: a `bun:sqlite` store
  runs each in a transaction, with UNIQUE indexes for logins, names and
  roles;
- returns copies, never what it keeps;
- keeps blobs per account, and addresses content by its SHA-256:
  `blobIdOf(bytes)` takes a `Uint8Array` only, so content given as a
  stream is hashed chunk by chunk — `readBlob(content)` does that, and
  returns `{ blobId, size, blob }`;
- keeps flags with `normalizeFlag`;
- follows the UID and modseq rules above.

```ts
import { readBlob } from '@bumail/store';

const { blobId, size, blob } = await readBlob(input.content); // INVALID on a bad stream
await Bun.write(`blobs/${account.id}/${blobId}`, blob);
```

The contract's specs, `describeMailStore`, live next to the stores in this
package and run against each of them; a store added here runs them too.
They are internal for now: a store written outside the package cannot run
them yet. And it follows the 0.x minor versions, in which the interface
may grow.
