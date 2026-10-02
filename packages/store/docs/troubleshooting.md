# Troubleshooting

Each entry is headed by the message of the `StoreError` thrown; its `code`
is the group it is listed under. The parts shown as … vary.

**NOT_FOUND**

- [`StoreError: No account "…"`](#storeerror-no-account-)
- [`StoreError: No mailbox "…"`](#storeerror-no-mailbox-)
- [`StoreError: No message "…"`](#storeerror-no-message-)
- [`StoreError: Message "…" is not in mailbox "…"`](#storeerror-message--is-not-in-mailbox-)

**ALREADY_EXISTS**

- [`StoreError: An account "…" already exists`](#storeerror-an-account--already-exists)
- [`StoreError: A mailbox "…" already exists there`](#storeerror-a-mailbox--already-exists-there)
- [`StoreError: The account already has a mailbox with the role …`](#storeerror-the-account-already-has-a-mailbox-with-the-role-)

**INVALID**

- [`StoreError: An account needs a name`](#storeerror-an-account-needs-a-name)
- [`StoreError: "…" is not a mailbox name`](#storeerror--is-not-a-mailbox-name)
- [`StoreError: A mailbox name cannot hold "/": "…"; give a parentId instead`](#storeerror-a-mailbox-name-cannot-hold---give-a-parentid-instead)
- [`StoreError: "…" is not a mailbox role`](#storeerror--is-not-a-mailbox-role)
- [`StoreError: A parent mailbox must be in the same account`](#storeerror-a-parent-mailbox-must-be-in-the-same-account)
- [`StoreError: A mailbox cannot be inside itself`](#storeerror-a-mailbox-cannot-be-inside-itself)
- [`StoreError: Only an empty mailbox can be deleted without removeMessages`](#storeerror-only-an-empty-mailbox-can-be-deleted-without-removemessages)
- [`StoreError: A mailbox with children cannot be deleted`](#storeerror-a-mailbox-with-children-cannot-be-deleted)
- [`StoreError: "…" is not a flag a store keeps`](#storeerror--is-not-a-flag-a-store-keeps)
- [`StoreError: Messages only move between mailboxes of their own account`](#storeerror-messages-only-move-between-mailboxes-of-their-own-account)
- [`StoreError: Mailbox "…" has run out of UIDs`](#storeerror-mailbox--has-run-out-of-uids)
- [`StoreError: A message content is a Uint8Array or a ReadableStream<Uint8Array>`](#storeerror-a-message-content-is-a-uint8array-or-a-readablestreamuint8array)
- [`StoreError: receivedAt is not a valid date`](#storeerror-receivedat-is-not-a-valid-date)
- [`StoreError: … must be an integer of at least 0, not …`](#storeerror--must-be-an-integer-of-at-least-0-not-)
- [`StoreError: since must be a modseq the account has given, from 0 to …, not …`](#storeerror-since-must-be-a-modseq-the-account-has-given-from-0-to--not-)
- [`StoreError: limit must be a positive integer, not …`](#storeerror-limit-must-be-a-positive-integer-not-)

**CANNOT_CALCULATE_CHANGES**

- [`StoreError: Changes since … are forgotten; start again from 0`](#storeerror-changes-since--are-forgotten-start-again-from-0)

## `StoreError: No account "…"`

**Code**: `NOT_FOUND`.

**When**: a method was given an account id that names no account — never created, or deleted.

**Fix**: Look the account up with `findAccount(login)` or `getAccount(id)`, which return `undefined` instead of throwing.

```ts
const account = await store.findAccount('mary@example.net');
if (account) await store.listMailboxes(account.id);
```

## `StoreError: No mailbox "…"`

**Code**: `NOT_FOUND`.

**When**: a mailbox id names no mailbox: `addMessage`, `listMessages`, `renameMailbox`, `deleteMailbox`, a copy, link or move target or source, or a `parentId`.

**Fix**: Read the mailbox first with `getMailbox(id)` or `findMailbox(accountId, role)`; another client may have deleted it.

```ts
const inbox = await store.findMailbox(account.id, 'inbox');
if (inbox) await store.addMessage(inbox.id, { content });
```

## `StoreError: No message "…"`

**Code**: `NOT_FOUND`.

**When**: one of the ids given to `setFlags`, `copyMessages`, `linkMessages`, `moveMessages`, `removeMessages` or `destroyMessages` names no message. Nothing was changed, even for the ids that were good.

**Fix**: Drop the ids that are gone — `getMessage(id)` returns `undefined` for them — and call again.

```ts
const live = [];
for (const id of ids) if (await store.getMessage(id)) live.push(id);
await store.setFlags(live, { add: ['\\Seen'] });
```

## `StoreError: Message "…" is not in mailbox "…"`

**Code**: `NOT_FOUND`.

**When**: `moveMessages` or `removeMessages` was given a message that is not in the mailbox it should leave: already moved or removed, maybe by another client.

**Fix**: Check `message.mailboxes`, or list the mailbox, before moving or removing.

```ts
const entries = await store.listMessages(inbox.id);
const here = entries.map((entry) => entry.message.id);
await store.removeMessages(ids.filter((id) => here.includes(id)), inbox.id);
```

## `StoreError: An account "…" already exists`

**Code**: `ALREADY_EXISTS`.

**When**: `createAccount` was given a login another account has, compared without case.

**Fix**: Use the existing account.

```ts
const account = (await store.findAccount(login)) ?? (await store.createAccount(login));
```

## `StoreError: A mailbox "…" already exists there`

**Code**: `ALREADY_EXISTS`.

**When**: `createMailbox` or `renameMailbox` would put two mailboxes of one name under the same parent. `INBOX` at the top matches `inbox` in any case.

**Fix**: Pick another name or parent, or use the mailbox that is there.

```ts
const boxes = await store.listMailboxes(account.id);
const work = boxes.find((box) => box.name === 'Work' && box.parentId === undefined)
	?? (await store.createMailbox(account.id, { name: 'Work' }));
```

## `StoreError: The account already has a mailbox with the role …`

**Code**: `ALREADY_EXISTS`.

**When**: `createMailbox` was given a role another mailbox of the account has. A role is unique in its account.

**Fix**: Use `findMailbox(accountId, role)`, or create the mailbox without a role.

```ts
const trash = (await store.findMailbox(account.id, 'trash'))
	?? (await store.createMailbox(account.id, { name: 'Trash', role: 'trash' }));
```

## `StoreError: An account needs a name`

**Code**: `INVALID`.

**When**: `createAccount` was given an empty or blank login, or not a string.

**Fix**: Pass the login, usually the account's address.

```ts
await store.createAccount('mary@example.net');
```

## `StoreError: "…" is not a mailbox name`

**Code**: `INVALID`.

**When**: a mailbox name is empty once trimmed, longer than 255 characters, holds a control character such as CR or LF, or is not a string.

**Fix**: Strip control characters and keep the name short.

```ts
await store.createMailbox(account.id, { name: name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) });
```

## `StoreError: A mailbox name cannot hold "/": "…"; give a parentId instead`

**Code**: `INVALID`.

**When**: a mailbox name holds `/`. The store's hierarchy is `parentId`, so an IMAP layer can use `/` as its delimiter.

**Fix**: Create each level with its parent.

```ts
const work = await store.createMailbox(account.id, { name: 'Work' });
await store.createMailbox(account.id, { name: 'Clients', parentId: work.id }); // not 'Work/Clients'
```

## `StoreError: "…" is not a mailbox role`

**Code**: `INVALID`.

**When**: `createMailbox` was given a role that is not one of `MAILBOX_ROLES`.

**Fix**: Use one of `inbox`, `drafts`, `sent`, `trash`, `junk`, `archive`, or no role.

```ts
import { MAILBOX_ROLES } from '@bumail/store';
const role = MAILBOX_ROLES.includes(given) ? given : undefined;
```

## `StoreError: A parent mailbox must be in the same account`

**Code**: `INVALID`.

**When**: a `parentId` names a mailbox of another account.

**Fix**: Give a parent from the same account.

```ts
const parent = await store.findMailbox(account.id, 'archive');
if (parent) await store.createMailbox(account.id, { name: '2026', parentId: parent.id });
```

## `StoreError: A mailbox cannot be inside itself`

**Code**: `INVALID`.

**When**: `renameMailbox` was given a `parentId` that is the mailbox itself or one of its descendants.

**Fix**: Move the mailbox under a parent outside its own subtree, or to the top by leaving `parentId` out.

```ts
await store.renameMailbox(work.id, 'Work'); // to the top
```

## `StoreError: Only an empty mailbox can be deleted without removeMessages`

**Code**: `INVALID`.

**When**: `deleteMailbox` was called on a mailbox that holds messages.

**Fix**: Pass `removeMessages: true` to take them out in the same step; a message in no other mailbox is destroyed. Or move them first.

```ts
await store.deleteMailbox(old.id, { removeMessages: true });
```

## `StoreError: A mailbox with children cannot be deleted`

**Code**: `INVALID`.

**When**: `deleteMailbox` was called on a mailbox that is the parent of another.

**Fix**: Delete or move the children first.

```ts
for (const child of (await store.listMailboxes(account.id)).filter((box) => box.parentId === work.id)) {
	await store.deleteMailbox(child.id, { removeMessages: true });
}
await store.deleteMailbox(work.id, { removeMessages: true });
```

## `StoreError: "…" is not a flag a store keeps`

**Code**: `INVALID`.

**When**: a flag is neither a system flag (`\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`) nor a keyword: printable ASCII without white space, `(`, `)`, `{`, `%`, `*`, `"`, `\` or `]`, 1 to 255 characters. `\Recent` is gone in IMAP4rev2. Nothing was changed.

**Fix**: Drop the flag, or spell it as a keyword.

```ts
await store.setFlags([message.id], { add: ['$label1'] }); // not 'label 1' or 'étiquette'
```

## `StoreError: Messages only move between mailboxes of their own account`

**Code**: `INVALID`.

**When**: `copyMessages`, `linkMessages`, `moveMessages` or `removeMessages` was given a message and a mailbox of different accounts.

**Fix**: Add the message to the other account instead, from its content.

```ts
const blob = await store.readContent(message.blobId);
if (blob) await store.addMessage(theirInbox.id, { content: blob.stream() });
```

## `StoreError: Mailbox "…" has run out of UIDs`

**Code**: `INVALID`.

**When**: a mailbox has given UID 4294967295, the highest RFC 9051 allows, and takes no more messages.

**Fix**: Create a new mailbox — it starts again at UID 1 with a new UIDVALIDITY — and move the messages there.

```ts
const fresh = await store.createMailbox(account.id, { name: 'Archive 2' });
```

## `StoreError: A message content is a Uint8Array or a ReadableStream<Uint8Array>`

**Code**: `INVALID`.

**When**: `addMessage` was given content of another type — a string, a `Buffer` view of something else, or a stream of strings.

**Fix**: Encode text, or pass a byte stream.

```ts
await store.addMessage(inbox.id, { content: new TextEncoder().encode(text) });
await store.addMessage(inbox.id, { content: Bun.file('message.eml').stream() });
```

## `StoreError: receivedAt is not a valid date`

**Code**: `INVALID`.

**When**: `addMessage` was given a `receivedAt` that is an invalid `Date`, such as `new Date('not a date')`.

**Fix**: Pass a valid date, or leave it out for now.

```ts
await store.addMessage(inbox.id, { content, receivedAt: new Date(header) }); // check it first:
// if (Number.isNaN(date.getTime())) leave receivedAt out
```

## `StoreError: … must be an integer of at least 0, not …`

**Code**: `INVALID`.

**When**: `changedSince` (`listMessages`) or `unchangedSince` (`setFlags`) is negative, fractional or not a number; or `maxTombstones` was so given to `new MemoryMailStore`.

**Fix**: Pass a modseq the store gave, or 0.

```ts
await store.listMessages(inbox.id, { changedSince: message.modseq });
```

## `StoreError: since must be a modseq the account has given, from 0 to …, not …`

**Code**: `INVALID`.

**When**: `messageChanges` or `mailboxChanges` was given a `since` above the account's modseq, negative or fractional — often a modseq from another account or another store.

**Fix**: Pass 0, or the `modseq` a previous call for this account returned.

```ts
const { modseq } = await store.messageChanges(account.id, 0);
```

## `StoreError: limit must be a positive integer, not …`

**Code**: `INVALID`.

**When**: `messageChanges` or `mailboxChanges` was given a `limit` of 0, a negative or fractional one.

**Fix**: Pass a positive integer, or leave `limit` out for all the changes at once.

```ts
await store.messageChanges(account.id, since, { limit: 500 });
```

## `StoreError: Changes since … are forgotten; start again from 0`

**Code**: `CANNOT_CALCULATE_CHANGES`.

**When**: the store no longer remembers removals as old as `since`: `MemoryMailStore` with `maxTombstones`, or a store that prunes them.

**Fix**: Start again: read everything as of now, and keep the returned `modseq`. This is JMAP's `cannotCalculateChanges` and a full QRESYNC.

```ts
try {
	await store.messageChanges(account.id, since);
} catch (error) {
	if ((error as StoreError).code !== 'CANNOT_CALCULATE_CHANGES') throw error;
	since = (await store.messageChanges(account.id, 0)).modseq; // and reload every mailbox
}
```
