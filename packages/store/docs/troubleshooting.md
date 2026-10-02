# Troubleshooting

Each entry is headed by the message of the `StoreError` thrown; its `code`
is the group it is listed under. The parts shown as … vary.

**NOT_FOUND**

- [`StoreError: No account "…"`](#storeerror-no-account-)
- [`StoreError: No mailbox "…"`](#storeerror-no-mailbox-)

**ALREADY_EXISTS**

- [`StoreError: An account "…" already exists`](#storeerror-an-account--already-exists)
- [`StoreError: A mailbox "…" already exists there`](#storeerror-a-mailbox--already-exists-there)
- [`StoreError: The account already has a mailbox with the role …`](#storeerror-the-account-already-has-a-mailbox-with-the-role-)

**INVALID**

- [`StoreError: An account needs a name`](#storeerror-an-account-needs-a-name)
- [`StoreError: "…" is not a mailbox name`](#storeerror--is-not-a-mailbox-name)
- [`StoreError: A mailbox name cannot hold "/": "…"; give a parentId instead`](#storeerror-a-mailbox-name-cannot-hold---give-a-parentid-instead)
- [`StoreError: "…" is not a mailbox role`](#storeerror--is-not-a-mailbox-role)
- [`StoreError: A mailbox cannot be inside itself`](#storeerror-a-mailbox-cannot-be-inside-itself)
- [`StoreError: Only an empty mailbox can be deleted without removeMessages`](#storeerror-only-an-empty-mailbox-can-be-deleted-without-removemessages)
- [`StoreError: A mailbox with children cannot be deleted`](#storeerror-a-mailbox-with-children-cannot-be-deleted)
- [`StoreError: "…" is not a flag a store keeps`](#storeerror--is-not-a-flag-a-store-keeps)
- [`StoreError: Flags are an array of strings`](#storeerror-flags-are-an-array-of-strings)
- [`StoreError: A flag change is an object`](#storeerror-a-flag-change-is-an-object)
- [`StoreError: ids must be an array of strings`](#storeerror-ids-must-be-an-array-of-strings)
- [`StoreError: Mailbox "…" has run out of UIDs`](#storeerror-mailbox--has-run-out-of-uids)
- [`StoreError: A new message is an object`](#storeerror-a-new-message-is-an-object)
- [`StoreError: A new mailbox is an object`](#storeerror-a-new-mailbox-is-an-object)
- [`StoreError: isSubscribed is true or false`](#storeerror-issubscribed-is-true-or-false)
- [`StoreError: A message content is a Uint8Array or a ReadableStream<Uint8Array>`](#storeerror-a-message-content-is-a-uint8array-or-a-readablestreamuint8array)
- [`StoreError: The message content stream is locked: another reader holds it`](#storeerror-the-message-content-stream-is-locked-another-reader-holds-it)
- [`StoreError: The message content could not be read: …`](#storeerror-the-message-content-could-not-be-read-)
- [`StoreError: receivedAt is not a valid date`](#storeerror-receivedat-is-not-a-valid-date)
- [`StoreError: "…" is not a thread id`](#storeerror--is-not-a-thread-id)
- [`StoreError: … must be an integer of at least …, not …`](#storeerror--must-be-an-integer-of-at-least--not-)
- [`StoreError: since must be a modseq the account has given, from 0 to …, not …`](#storeerror-since-must-be-a-modseq-the-account-has-given-from-0-to--not-)
- [`StoreError: limit must be a positive integer, not …`](#storeerror-limit-must-be-a-positive-integer-not-)

**CANNOT_CALCULATE_CHANGES**

- [`StoreError: Changes since … are forgotten; ask for the changes since 0, which lists every item as created`](#storeerror-changes-since--are-forgotten-ask-for-the-changes-since-0-which-lists-every-item-as-created)

## `StoreError: No account "…"`

**Code**: `NOT_FOUND`.

**When**: a method was given an account id that names no account — never created, or deleted. Every method that takes an account id throws it, `getMailbox`, `getMessage` and `readContent` included.

**Fix**: Look the account up with `findAccount(login)` or `getAccount(id)`, which return `undefined` instead of throwing.

```ts
const account = await store.findAccount('mary@example.net');
if (account) await store.listMailboxes(account.id);
```

## `StoreError: No mailbox "…"`

**Code**: `NOT_FOUND`.

**When**: a mailbox id names no mailbox of the account the call was given: `addMessage`, `listMessages`, `renameMailbox`, `setSubscribed`, `deleteMailbox`, a copy, link or move target or source, or a `parentId`. Another account's mailbox counts as none: every call acts in one account only.

**Fix**: Read the mailbox first with `getMailbox(accountId, id)` or `findMailbox(accountId, role)`; another client may have deleted it.

```ts
const inbox = await store.findMailbox(account.id, 'inbox');
if (inbox) await store.addMessage(account.id, inbox.id, { content });
```

To put a message in another account, add it there from its content:

```ts
const blob = await store.readContent(account.id, message.blobId);
if (blob) await store.addMessage(other.id, theirInbox.id, { content: blob.stream() });
```

A message id that names nothing is not an error: `setFlags`,
`copyMessages`, `linkMessages`, `moveMessages`, `removeMessages` and
`destroyMessages` skip it, act on the others, and list it in the result's
`notFound` — a message gone, another account's, or not in the mailbox the
call works on.

```ts
const { messages, notFound } = await store.setFlags(account.id, ids, { add: ['\\Seen'] });
if (notFound.length > 0) reload(); // another session removed them
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

**Fix**: Use one of `inbox`, `all`, `archive`, `drafts`, `flagged`, `important`, `junk`, `sent`, `trash`, or no role. `isMailboxRole` checks a string read from outside, and narrows it.

```ts
import { isMailboxRole } from '@bumail/store';
const role = isMailboxRole(given) ? given : undefined;
await store.createMailbox(account.id, { name, ...(role ? { role } : {}) });
```

## `StoreError: A mailbox cannot be inside itself`

**Code**: `INVALID`.

**When**: `renameMailbox` was given a `parentId` that is the mailbox itself or one of its descendants.

**Fix**: Move the mailbox under a parent outside its own subtree, or to the top by leaving `parentId` out.

```ts
await store.renameMailbox(account.id, work.id, 'Work'); // to the top
```

## `StoreError: Only an empty mailbox can be deleted without removeMessages`

**Code**: `INVALID`.

**When**: `deleteMailbox` was called on a mailbox that holds messages.

**Fix**: Pass `removeMessages: true` to take them out in the same step; a message in no other mailbox is destroyed. Or move them first.

```ts
await store.deleteMailbox(account.id, old.id, { removeMessages: true });
```

## `StoreError: A mailbox with children cannot be deleted`

**Code**: `INVALID`.

**When**: `deleteMailbox` was called on a mailbox that is the parent of another.

**Fix**: Delete or move the children first.

```ts
for (const child of (await store.listMailboxes(account.id)).filter((box) => box.parentId === work.id)) {
	await store.deleteMailbox(account.id, child.id, { removeMessages: true });
}
await store.deleteMailbox(account.id, work.id, { removeMessages: true });
```

## `StoreError: "…" is not a flag a store keeps`

**Code**: `INVALID`.

**When**: a flag is neither a system flag (`\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`) nor a keyword: printable ASCII without white space, `(`, `)`, `{`, `%`, `*`, `"`, `\` or `]`, 1 to 255 characters. `\Recent` is gone in IMAP4rev2. Nothing was changed.

**Fix**: Drop the flag, or spell it as a keyword.

```ts
await store.setFlags(account.id, [message.id], { add: ['$label1'] }); // not 'label 1' or 'étiquette'
```

## `StoreError: Flags are an array of strings`

**Code**: `INVALID`.

**When**: `flags` of `addMessage`, or `set`, `add` or `remove` of a `setFlags` change, is not an array — often one flag given as a string.

**Fix**: Wrap it in an array.

```ts
await store.setFlags(account.id, [message.id], { add: ['\\Seen'] });
```

## `StoreError: A flag change is an object`

**Code**: `INVALID`.

**When**: `setFlags` was given `null` or something other than an object as its change.

**Fix**: Pass `{ set }`, `{ add }`, `{ remove }`, or several of them.

```ts
await store.setFlags(account.id, ids, { add: ['\\Flagged'], remove: ['\\Seen'] });
```

## `StoreError: ids must be an array of strings`

**Code**: `INVALID`.

**When**: a method taking message ids was given one id as a string, or an array holding something else.

**Fix**: Pass an array of ids.

```ts
await store.destroyMessages(account.id, [message.id]);
```

## `StoreError: Mailbox "…" has run out of UIDs`

**Code**: `INVALID`.

**When**: a mailbox has given UID 4294967295, the highest RFC 9051 allows, and takes no more messages.

**Fix**: Create a new mailbox — it starts again at UID 1 with a new UIDVALIDITY — and move the messages there.

```ts
const fresh = await store.createMailbox(account.id, { name: 'Archive 2' });
```

## `StoreError: A new message is an object`

**Code**: `INVALID`.

**When**: `addMessage` was given `null` or something other than an object.

**Fix**: Pass `{ content }`, with any of `flags`, `receivedAt` and `threadId`.

```ts
await store.addMessage(account.id, inbox.id, { content: raw });
```

## `StoreError: A new mailbox is an object`

**Code**: `INVALID`.

**When**: `createMailbox` was given `null` or something other than an object.

**Fix**: Pass `{ name }`, with any of `parentId`, `role` and `isSubscribed`.

```ts
await store.createMailbox(account.id, { name: 'Lists' });
```

## `StoreError: isSubscribed is true or false`

**Code**: `INVALID`.

**When**: `createMailbox` was given an `isSubscribed`, or `setSubscribed` a value, that is not a boolean — such as the string `"true"` from a form.

**Fix**: Convert it first.

```ts
await store.setSubscribed(account.id, mailbox.id, form.get('subscribed') === 'on');
```

## `StoreError: A message content is a Uint8Array or a ReadableStream<Uint8Array>`

**Code**: `INVALID`.

**When**: `addMessage` was given content of another type — a string, or a stream that yields strings or anything else than `Uint8Array` chunks. The stream is cancelled, and nothing is added.

**Fix**: Encode text, or pass a byte stream.

```ts
await store.addMessage(account.id, inbox.id, { content: new TextEncoder().encode(text) });
await store.addMessage(account.id, inbox.id, { content: Bun.file('message.eml').stream() });
```

## `StoreError: The message content stream is locked: another reader holds it`

**Code**: `INVALID`.

**When**: `addMessage` was given a stream that something already reads: `stream.locked` is `true` — a `getReader()` not released, a `pipeTo` under way, or a stream read once already. Nothing was added.

**Fix**: Give the store a stream nothing else reads: release the reader, or `tee()` the stream and give it one branch.

```ts
const [forStore, forScan] = stream.tee();
await Promise.all([
	store.addMessage(account.id, inbox.id, { content: forStore }),
	scan(forScan),
]);
```

## `StoreError: The message content could not be read: …`

**Code**: `INVALID`.

**When**: the stream given to `addMessage` failed before its end — a connection reset, a size limit the stream's source enforced. The rest of the message is the stream's own error. Nothing was added.

**Fix**: Nothing to undo; accept the message again once its source is whole. An SMTP server answers with a 4xx so the sender retries.

```ts
try {
	await store.addMessage(account.id, inbox.id, { content: stream });
} catch (error) {
	if (!(error instanceof StoreError)) throw error;
	reply(451, 'Requested action aborted: local error in processing');
}
```

## `StoreError: receivedAt is not a valid date`

**Code**: `INVALID`.

**When**: `addMessage` was given a `receivedAt` that is an invalid `Date`, such as `new Date('not a date')`, or not a `Date` at all, such as a string or a timestamp.

**Fix**: Pass a valid date, or leave it out for now.

```ts
await store.addMessage(account.id, inbox.id, { content, receivedAt: new Date(header) }); // check it first:
// if (Number.isNaN(date.getTime())) leave receivedAt out
```

## `StoreError: "…" is not a thread id`

**Code**: `INVALID`.

**When**: `addMessage` was given a `threadId` that is empty, longer than 255 characters, holds a space or a character outside printable ASCII, or is not a string.

**Fix**: Pass the `threadId` of a message already in the thread, or leave it out for a thread of its own.

```ts
await store.addMessage(account.id, inbox.id, { content: reply, threadId: original.threadId });
```

## `StoreError: … must be an integer of at least …, not …`

**Code**: `INVALID`.

**When**: `changedSince` or `fromUid` (`listMessages`), `unchangedSince` (`setFlags`) or `offset` (`listAccountMessages`) is negative, fractional or not a number; `limit` of `listAccountMessages` is below 1; or `maxTombstones` was so given to `new MemoryMailStore`.

**Fix**: Pass a modseq or a UID the store gave, 0, or a positive count.

```ts
await store.listMessages(account.id, inbox.id, { changedSince: message.modseq });
await store.listAccountMessages(account.id, { offset: 50, limit: 50 });
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

## `StoreError: Changes since … are forgotten; ask for the changes since 0, which lists every item as created`

**Code**: `CANNOT_CALCULATE_CHANGES`.

**When**: the store no longer remembers removals as old as `since`: `MemoryMailStore` with `maxTombstones`, or a store that prunes them. A `since` of 0 never throws it.

**Fix**: Start over from 0. The changes since 0 are the account's whole state: every message, or mailbox for `mailboxChanges`, that exists is in `created`, and `destroyed` and `expunged` are empty — whatever the client holds that is not in `created` is gone. Its pages never end below what the store remembers, so each `hasMore` page can be asked for. This is JMAP's `cannotCalculateChanges` and a full QRESYNC.

```ts
try {
	return await store.messageChanges(account.id, since);
} catch (error) {
	if ((error as StoreError).code !== 'CANNOT_CALCULATE_CHANGES') throw error;
	const all = await store.messageChanges(account.id, 0); // page it with limit and hasMore
	forgetEverythingBut(all.created);
	return all;
}
```
