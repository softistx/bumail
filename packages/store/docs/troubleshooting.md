# Troubleshooting

Each entry is headed by the message of the `StoreError` thrown; its `code`
is the group it is listed under. The parts shown as … vary. The last two
groups are the stores' own: what opening a `bun:sqlite` directory, a
closed store and its content on disk can throw, then what opening and
setting up a PostgreSQL store can.

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
- [`StoreError: A rename is an object`](#storeerror-a-rename-is-an-object)
- [`StoreError: A rename gives a name, a parentId or both`](#storeerror-a-rename-gives-a-name-a-parentid-or-both)
- [`StoreError: parentId is a mailbox id or null`](#storeerror-parentid-is-a-mailbox-id-or-null)
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

**The `bun:sqlite` store** (`@bumail/store/sqlite`)

- [`StoreError: The store at "…" cannot be opened: it is already open, in this process or another: a database has one store at a time`](#storeerror-the-store-at--cannot-be-opened-it-is-already-open-in-this-process-or-another-a-database-has-one-store-at-a-time)
- [`StoreError: The store is closed`](#storeerror-the-store-is-closed)
- [`StoreError: The database is at schema version …, newer than this store's …`](#storeerror-the-database-is-at-schema-version--newer-than-this-stores-)
- [`StoreError: The store at "…" cannot be opened: file is not a database`](#storeerror-the-store-at--cannot-be-opened-file-is-not-a-database)
- [`StoreError: A SQLite store needs a directory`](#storeerror-a-sqlite-store-needs-a-directory)
- [`StoreError: The store at "…" cannot be opened: …`](#storeerror-the-store-at--cannot-be-opened-)
- [`StoreError: maxTombstones must be an integer of at least 0, not …`](#storeerror-maxtombstones-must-be-an-integer-of-at-least-0-not-)
- [`ENOENT: no such file or directory, open '…/blobs/…/…'`](#enoent-no-such-file-or-directory-open-blobs)

**The PostgreSQL store** (`@bumail/store/postgres`)

- [`StoreError: A PostgreSQL mail store needs sql: a Bun.SQL client or a postgres:// URL`](#storeerror-a-postgresql-mail-store-needs-sql-a-bunsql-client-or-a-postgres-url)
- [`StoreError: sql is a … client; the mail store needs a PostgreSQL one`](#storeerror-sql-is-a--client-the-mail-store-needs-a-postgresql-one)
- [`StoreError: tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`](#storeerror-tableprefix-must-be-lowercase-letters-digits-and-underscores-starting-with-a-letter-or-an-underscore-at-most-40-characters-not-)
- [`StoreError: The URL in sql cannot be opened: …`](#storeerror-the-url-in-sql-cannot-be-opened-)
- [`StoreError: The PostgreSQL mail store cannot be set up: …`](#storeerror-the-postgresql-mail-store-cannot-be-set-up-)
- [`StoreError: An account name PostgreSQL keeps holds no NUL and no lone surrogate`](#storeerror-an-account-name-postgresql-keeps-holds-no-nul-and-no-lone-surrogate)
- [`StoreError: An account name PostgreSQL keeps is at most 1024 bytes of UTF-8`](#storeerror-an-account-name-postgresql-keeps-is-at-most-1024-bytes-of-utf-8)
- [`StoreError: A mailbox name PostgreSQL keeps holds no NUL and no lone surrogate`](#storeerror-a-mailbox-name-postgresql-keeps-holds-no-nul-and-no-lone-surrogate)
- [`StoreError: The table "…" is already in the database, and is not the mail store's: give the store a tablePrefix of its own`](#storeerror-the-table--is-already-in-the-database-and-is-not-the-mail-stores-give-the-store-a-tableprefix-of-its-own)
- [`PostgresError: …`, or a connection error, from a call](#postgreserror--or-a-connection-error-from-a-call)

The `bun:sqlite` group's `The store is closed`, `The database is at
schema version …, newer than this store's …` and `maxTombstones must be
…` come from the PostgreSQL store too, for the same causes.

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

**When**: a mailbox id names no mailbox of the account the call was given: `addMessage`, `listMessages`, `renameMailbox`, `setSubscribed`, `deleteMailbox`, a copy, link or move target or source, a `parentId`, or `messageChanges`'s `mailboxId` — a mailbox deleted since included. Another account's mailbox counts as none: every call acts in one account only.

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

**When**: `createMailbox` or `findMailbox` was given a role that is not one of `MAILBOX_ROLES`. `findMailbox` also refuses no role at all (`undefined`, shown as `"undefined"`): it looks a mailbox up by its role.

**Fix**: Use one of `inbox`, `all`, `archive`, `drafts`, `flagged`, `important`, `junk`, `sent`, `trash`, or no role. `isMailboxRole` checks a string read from outside, and narrows it.

```ts
import { isMailboxRole } from '@bumail/store';
const role = isMailboxRole(given) ? given : undefined;
await store.createMailbox(account.id, { name, ...(role ? { role } : {}) });
```

## `StoreError: A mailbox cannot be inside itself`

**Code**: `INVALID`.

**When**: `renameMailbox` was given a `parentId` that is the mailbox itself or one of its descendants.

**Fix**: Move the mailbox under a parent outside its own subtree, or to the top with `parentId: null`.

```ts
await store.renameMailbox(account.id, work.id, { parentId: null }); // to the top
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

## `StoreError: A rename is an object`

**Code**: `INVALID`.

**When**: `renameMailbox` was given a string as its third argument, such as a bare name, or `null`.

**Fix**: Pass `{ name }`, `{ parentId }` or both.

```ts
await store.renameMailbox(account.id, work.id, { name: 'Projects' });
```

## `StoreError: A rename gives a name, a parentId or both`

**Code**: `INVALID`.

**When**: `renameMailbox` was given `{}`, or a change whose `name` and `parentId` are both `undefined`. `MailboxRename` refuses `{}` at compile time, so this comes from JavaScript or a value cast past the type.

**Fix**: Give what changes. Leaving a field out keeps it; `parentId: null` moves the mailbox to the top.

```ts
await store.renameMailbox(account.id, clients.id, { parentId: null });
```

## `StoreError: parentId is a mailbox id or null`

**Code**: `INVALID`.

**When**: `renameMailbox` was given a `parentId` that is neither a string nor `null`.

**Fix**: Pass the parent's `id`, `null` for the top, or leave `parentId` out to keep the parent.

```ts
await store.renameMailbox(account.id, clients.id, { parentId: work.id });
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

**When**: `changedSince` or `fromUid` (`listMessages`), `unchangedSince` (`setFlags`) or `offset` (`listAccountMessages`) is negative, fractional or not a number; `limit` of `listAccountMessages` is below 1; or `maxTombstones` was so given to `new MemoryMailStore` (its message names it: see [below](#storeerror-maxtombstones-must-be-an-integer-of-at-least-0-not-)).

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

**When**: `messageChanges` or `mailboxChanges` was given a `limit` of 0, a negative or fractional one. For `messageChanges` it counts `created`, `updated`, `destroyed` and `expunged` together.

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

## `StoreError: The store at "…" cannot be opened: it is already open, in this process or another: a database has one store at a time`

**Code**: `INVALID`.

**When**: `SqliteMailStore.open` was given a directory another `SqliteMailStore` holds open — one not yet closed in this process, or one in another process. A store keeps an exclusive lock on `mail.sqlite` until `close()`, and `open` does not wait for it. A second server started by mistake, a hot reload that opened again without closing, or each spec file opening the same directory all give it.

**Fix**: Open each directory once per process and share that store; close it before opening it again. Give another process its own directory, or stop the one that holds it.

```ts
const store = SqliteMailStore.open({ directory });
try {
	await serve(store);
} finally {
	store.close(); // the next open, here or elsewhere, succeeds
}
```

## `StoreError: The store is closed`

**Code**: `INVALID`.

**When**: a method of a `SqliteMailStore` or a `PostgresMailStore` was called after its `close()`. A request still running at shutdown is the usual one.

**Fix**: Close the store last, once the servers that use it have stopped taking requests.

```ts
await server.stop(); // the SMTP server: no new delivery from here
store.close(); // await it, for a PostgresMailStore
```

## `StoreError: The database is at schema version …, newer than this store's …`

**Code**: `INVALID`.

**When**: `mail.sqlite`, or a PostgreSQL store's tables, were written by a newer `@bumail/store`, whose migrations this version does not know: the package was downgraded, or two versions share a directory or a database — an instance not yet upgraded, after another ran `migrate()`. The database is left as it was.

**Fix**: Run the `@bumail/store` that wrote it, or a newer one. To go back to an older version, restore a backup taken before the upgrade.

```sh
bun add @bumail/store@latest
```

## `StoreError: The store at "…" cannot be opened: file is not a database`

**Code**: `INVALID`.

**When**: `mail.sqlite` in the directory is not a SQLite database: another file of that name, a truncated copy, or a database encrypted by another tool.

**Fix**: Point `directory` at the store's own directory. If the file is the store's and damaged, restore it from a backup, with its `mail.sqlite-wal` and `blobs/`, as the [guide](guide.md#backups) says.

```ts
SqliteMailStore.open({ directory: '/var/lib/bumail/mail' }); // the directory, not mail.sqlite
```

## `StoreError: A SQLite store needs a directory`

**Code**: `INVALID`.

**When**: `SqliteMailStore.open` was called without options, or with a `directory` that is not a string or is empty — often an environment variable that is not set.

**Fix**: Pass the directory the store keeps its mail in. It is created if it is missing.

```ts
const directory = process.env.MAIL_DIR;
if (!directory) throw new Error('MAIL_DIR is not set');
const store = SqliteMailStore.open({ directory });
```

## `StoreError: The store at "…" cannot be opened: …`

**Code**: `INVALID`.

**When**: the directory, `mail.sqlite` or `blobs/` could not be made or opened, for the reason after the colon: `EACCES: permission denied` or, on macOS, `EPERM: operation not permitted` (the server's user may not write there), `ENOTDIR: not a directory` (a part of the path is a file), `EROFS` (a read-only filesystem), or SQLite's own message.

**Fix**: Give the user the server runs as a directory of its own that it can write, 0700.

```sh
install -d -m 0700 -o bumail -g bumail /var/lib/bumail/mail
```

## `StoreError: maxTombstones must be an integer of at least 0, not …`

**Code**: `INVALID`.

**When**: `SqliteMailStore.open`, `PostgresMailStore.open`, or `new MemoryMailStore`, was given a `maxTombstones` that is negative, fractional, `NaN` or not a number — often a setting read from the environment as a string.

**Fix**: Pass an integer of at least 0, `Infinity`, or leave it out to remember every removal.

```ts
const maxTombstones = process.env.MAX_TOMBSTONES
	? Number(process.env.MAX_TOMBSTONES) // a number, not "10000"
	: Infinity; // unset or empty: remember every removal
SqliteMailStore.open({ directory, maxTombstones });
```

## `ENOENT: no such file or directory, open '…/blobs/…/…'`

**Code**: none: a plain `Error` with `code: 'ENOENT'`, not a `StoreError`.

**When**: a Blob `readContent` returned by a `SqliteMailStore` was read after its message left the account — destroyed, its last mailbox removed, or its account deleted — and no other message of the account had the same bytes. The Blob is lazy: it reads its file when read, and that file is removed once no message of the account uses it. The contract allows this: the Blob is valid until its message leaves the account.

**Fix**: Read the content before removing its message, or ask for it again and treat `undefined` as gone.

```ts
const content = await store.readContent(account.id, message.blobId);
const raw = await content?.arrayBuffer(); // read first…
await store.destroyMessages(account.id, [message.id]); // …then remove
```

## `StoreError: A PostgreSQL mail store needs sql: a Bun.SQL client or a postgres:// URL`

**Code**: `INVALID`.

**When**: `PostgresMailStore.open` was called without options or without `sql`, with a string that is not a `postgres://` or `postgresql://` URL, or with an object that lacks `unsafe`, `begin` and `close`. The message never repeats what was given, which may hold a password.

**Fix**: Give a `Bun.SQL` client of yours, or the database's URL.

```ts
PostgresMailStore.open({ sql: new Bun.SQL({ url: Bun.env['DATABASE_URL'], max: 10 }) });
// or a client of the store's own, closed by close():
PostgresMailStore.open({ sql: 'postgres://bumail:secret@db.internal:5432/mail' });
```

## `StoreError: sql is a … client; the mail store needs a PostgreSQL one`

**Code**: `INVALID`.

**When**: `sql` is a `Bun.SQL` client made for SQLite or MySQL (`adapter: 'sqlite'`, a `mysql://` URL).

**Fix**: For one process on one disk, use `@bumail/store/sqlite`; otherwise give a PostgreSQL client.

```ts
PostgresMailStore.open({ sql: new Bun.SQL('postgres://bumail@db.internal/mail') });
```

## `StoreError: tablePrefix must be lowercase letters, digits and underscores, starting with a letter or an underscore, at most 40 characters, not …`

**Code**: `INVALID`.

**When**: `tablePrefix` holds anything else: a capital, a dot, a dash, a quote, or more than 40 characters. The prefix is written into every statement, never bound as a value, so nothing but a plain name is taken; 40 characters keep every name built on it within PostgreSQL's 63.

**Fix**: A plain name. To put the tables in another schema, set the connection's `search_path` rather than a dotted prefix.

```ts
PostgresMailStore.open({ sql, tablePrefix: 'mail_' });
```

## `StoreError: The URL in sql cannot be opened: …`

**Code**: `INVALID`.

**When**: `PostgresMailStore.open` was given a URL `Bun.SQL` refuses before connecting, such as a `sslmode` it does not know. The rest is Bun's reason (`The argument 'sslmode' must be one of: disable, allow, prefer, require, verify-ca, verify-full. Received '…'`); the URL is never repeated, and the password is masked should the reason name it.

**Fix**: Correct the parameter.

```ts
PostgresMailStore.open({ sql: 'postgres://bumail@db.internal/mail?sslmode=verify-full' });
```

## `StoreError: The PostgreSQL mail store cannot be set up: …`

**Code**: `INVALID`.

**When**: the first call on a store, or `migrate()`, could not make the tables or bring them up to date. The rest is the database's reason: `Failed to connect`, `password authentication failed for user "…"`, `permission denied for schema public`.

**Why**: the database is out of reach, the credentials are wrong, or the tables are missing or behind and the role may not create them: a role without `CREATE` uses tables that are current, and never makes them.

**Fix**: Check the URL, and that the server answers. For `permission denied`, run `migrate()` once with the owner's role — on a new database, and after an upgrade that adds a migration — and keep the servers on their narrower role (the guide's [Migrations and roles](guide.md#migrations-and-roles)), or give the role `CREATE` on the schema. Nothing is left half made, since a migration is one transaction, and the next call tries again.

```ts
// a deploy step, with the owner's role
const owner = PostgresMailStore.open({ sql: Bun.env['OWNER_DATABASE_URL'] as string });
await owner.migrate();
await owner.close();
```

## `StoreError: An account name PostgreSQL keeps holds no NUL and no lone surrogate`

**Code**: `INVALID`.

**When**: `createAccount` on a `PostgresMailStore` was given a login holding U+0000, or half of a UTF-16 surrogate pair. PostgreSQL's `text` holds no NUL, and `Bun.sql` would send the lone surrogate as U+FFFD: the account would be kept, and found, under another name. The memory store takes such a login.

**Fix**: Refuse the login where it comes in; one read from IMAP or JMAP is well-formed already. To keep a string you cut yourself, cut it whole.

```ts
if (!login.isWellFormed() || login.includes('\0')) throw new Error('bad login');
await store.createAccount(login);
```

## `StoreError: An account name PostgreSQL keeps is at most 1024 bytes of UTF-8`

**Code**: `INVALID`.

**When**: `createAccount` on a `PostgresMailStore` was given a login longer than 1024 bytes once encoded as UTF-8. The login's key is in a unique index, whose entries PostgreSQL caps at about 2.7 KB; the store refuses well below that rather than let PostgreSQL's own error through. The memory and SQLite stores take such a login.

**Fix**: Refuse it where it comes in: an address is at most 256 octets (RFC 5321 §4.5.3.1).

```ts
if (new TextEncoder().encode(login).length > 256) throw new Error('login too long');
await store.createAccount(login);
```

## `StoreError: A mailbox name PostgreSQL keeps holds no NUL and no lone surrogate`

**Code**: `INVALID`.

**When**: `createMailbox` or `renameMailbox` on a `PostgresMailStore` was given a name holding half of a UTF-16 surrogate pair (a NUL is already `"…" is not a mailbox name`, as a control character). The memory store takes such a name.

**Fix**: Make the name well-formed first; `toWellFormed()` puts U+FFFD in place of each lone half.

```ts
await store.createMailbox(account.id, { name: name.toWellFormed() });
```

## `StoreError: The table "…" is already in the database, and is not the mail store's: give the store a tablePrefix of its own`

**Code**: `INVALID`.

**When**: the first call on a `PostgresMailStore`, or `migrate()`, was about to make the tables on a database where none of the store's are recorded yet, and found a `<prefix>schema` or one of its own tables' names taken. Most often a `@bumail/queue/postgres` queue was given the same `tablePrefix`: the queue has a `<prefix>schema` and a `<prefix>messages`. Nothing is created; the store refuses rather than share a table that is not its own.

**Fix**: The store's `tablePrefix` must never be the same as the queue's, or any other package's. Give each its own; the defaults already differ.

```ts
const store = PostgresMailStore.open({ sql, tablePrefix: 'mail_' });
const queue = PostgresQueueStore.open({ sql, tablePrefix: 'outbound_' });
```

## `PostgresError: …`, or a connection error, from a call

**Code**: none: `Bun.sql`'s own error, not a `StoreError`.

**When**: a call on a `PostgresMailStore` whose tables are set up, when the database fails it: the server restarted or is out of reach, a connection dropped, the server refused one past its `max_connections`, or a statement timed out (`statement_timeout`). As the `bun:sqlite` store passes its disk errors on, this store passes these on as they are. A call that failed before its commit is rolled back and changed nothing; one whose connection dropped during the commit itself may have committed, and cannot know.

**Fix**: Check the server is up and reachable. When it counts too many connections, give each instance's client a smaller `max`, or raise `max_connections`. Before adding a message again after such an error, look for it: its UID may already be taken.

```ts
const sql = new Bun.SQL({ url: Bun.env['DATABASE_URL'], max: 5 });
```
