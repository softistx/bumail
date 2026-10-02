# Guide

- [The contract](#the-contract)
- [Accounts](#accounts)
- [Mailboxes](#mailboxes)
- [Messages, UIDs and modseqs](#messages-uids-and-modseqs)
- [Flags](#flags)
- [Copying, moving, removing](#copying-moving-removing)
- [Changes](#changes)
- [Writing a store](#writing-a-store)

## The contract

`MailStore` is an interface; `MemoryMailStore` is its first answer, and a
`bun:sqlite` store is coming. Code that keeps mail takes a `MailStore`:

```ts
import type { MailStore } from '@bumail/store';

async function deliver(store: MailStore, login: string, raw: Uint8Array) {
	const account = await store.findAccount(login);
	if (!account) return false;
	const inbox = await store.findMailbox(account.id, 'inbox');
	if (!inbox) return false;
	await store.addMessage(inbox.id, { content: raw });
	return true;
}
```

Every method is asynchronous, so a store may live across a network. Every
refusal is a `StoreError` with a `code`: `NOT_FOUND`, `ALREADY_EXISTS` or
`INVALID`. A getter — `getAccount`, `getMailbox`, `getMessage`,
`findAccount`, `findMailbox`, `readContent` — returns `undefined` for what
does not exist instead of throwing.

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
```

- A mailbox has a `name`, an optional `parentId` for a hierarchy, and an
  optional `role`: `inbox`, `drafts`, `sent`, `trash`, `junk`, `archive`
  (RFC 6154, RFC 8621). A role is unique in its account.
- A name is unique under its parent, and holds no control character. The
  store sets no hierarchy delimiter: IMAP's `/` is the IMAP layer's
  business.
- `uidValidity` is fixed for the mailbox's life, and differs between
  mailboxes; `uidNext`, `highestModseq`, `messages` and `unseen` are
  counted when you read the mailbox.
- `deleteMailbox` deletes only an empty mailbox with no children.

## Messages, UIDs and modseqs

```ts
const message = await store.addMessage(inbox.id, {
	content: raw,
	flags: ['\\Seen'],
	receivedAt: new Date(),
});
// { id, accountId, mailboxId, uid, modseq, flags, receivedAt, size, blobId }

await store.listMessages(inbox.id); // in UID order
await store.listMessages(inbox.id, 120); // from UID 120
await store.readContent(message.blobId); // the bytes
```

- **UIDs** ascend strictly within a mailbox and are never reused, even
  after a removal (RFC 9051 §2.3.1.1).
- **Modseqs** count the changes of the whole **account**: each add, flag
  change or removal takes the next one. A mailbox's `highestModseq` is the
  last one that touched it, so it ascends too, as RFC 7162 needs.
- **Content** is kept once per distinct bytes: `blobId` is the SHA-256 of
  the content in hex, and a copy shares it.

The store does not parse a message: it keeps bytes. Parse them with
`@bumail/mime` when you need headers.

## Flags

```ts
await store.setFlags([message.id], { add: ['\\Flagged'], remove: ['\\Seen'] });
await store.setFlags([message.id], { set: ['$Forwarded'] }); // replaces every flag
```

A flag is a system flag — `\Seen`, `\Answered`, `\Flagged`, `\Deleted`,
`\Draft`, in any case, stored in this case — or a keyword such as
`$Forwarded` or `$label1`. `\Recent`, gone in IMAP4rev2, and anything with
white space, parentheses, `{`, `%`, `*`, `"`, `\` or `]` is `INVALID`.
Flags come back sorted. A change that changes nothing takes no modseq.

## Copying, moving, removing

```ts
const archive = await store.createMailbox(account.id, { name: 'Archive', role: 'archive' });
await store.copyMessages([message.id], archive.id); // new UIDs, same blob, same flags
await store.moveMessages([message.id], archive.id); // a copy, then a removal (RFC 6851)
await store.removeMessages([message.id]); // gone; its blob too, once nothing uses it
```

Messages never leave their account: a copy or a move to another account's
mailbox is `INVALID`.

## Changes

```ts
const first = await store.changes(account.id, 0);
// … later
const { modseq, messages, removed } = await store.changes(account.id, first.modseq);
```

`messages` holds every message added or changed after `since`, in modseq
order, as it is now; `removed` holds each message removed after it, with
its mailbox and UID. Pass the returned `modseq` back next time. This is
the basis of IMAP's CONDSTORE and QRESYNC (RFC 7162) and of JMAP's
`Email/changes`.

`MemoryMailStore` remembers removed messages for the life of the store.

## Writing a store

A store of your own implements `MailStore` and:

- throws `StoreError` with the codes above, for the same causes;
- addresses content with `blobIdOf(content)`;
- keeps flags with `normalizeFlag`;
- follows the UID and modseq rules above.

The contract's specs live next to the stores in this package and run
against each of them; a store added here runs them too.
