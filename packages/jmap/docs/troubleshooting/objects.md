# Troubleshooting: objects not created, updated or destroyed

What one object of a `/set` or an `Email/import` answers when it fails,
in `notCreated`, `notUpdated` or `notDestroyed`: a SetError
`{ "type": …, "description"?: …, "properties"?: [ … ] }` (RFC 8620 §5.3).
The other objects of the call still go ahead. Each entry is headed by the
`type`, and the `description` where there is one. The
[index](../troubleshooting.md) lists every entry of every page.

## `notFound`

The id names nothing in the account: never did, destroyed since, or
another account's.

## `invalidProperties` — `name is required`

A mailbox create without `name`.

## `invalidProperties` — `name is a string`

A mailbox's `name` is a number, `null` or an object. Send a string.

## `invalidProperties` — `parentId names no mailbox`

`parentId` is not an id, nor a `#creationId` of a mailbox created earlier
in the request, nor `null`.

## `invalidProperties` — `role is not one this server knows`

The roles are `inbox`, `all`, `archive`, `drafts`, `flagged`,
`important`, `junk`, `sent` and `trash`.

## `invalidProperties` — `isSubscribed is a boolean`

Send `true` or `false`.

## `invalidProperties` — `sortOrder can only be 0`

The store keeps no sort order: every mailbox has 0.

## `invalidProperties` — `This property cannot be set`

A mailbox create gave a server-set property — `id`, `totalEmails`,
`myRights` and the like — or one that does not exist.

## `invalidProperties` — `This property cannot be changed`

A mailbox update changed something other than `name`, `parentId` and
`isSubscribed`: a `role` (the store cannot change one), a server-set
property, a path into a property.

## `invalidProperties` — `…`, with `properties: ["name"]`

The store refused the name or the move: a name already taken under that
parent, a name with `/` or a control character, more than 255
characters, a role another mailbox has, a move under the mailbox's own
child. The description is the store's message.

## `invalidProperties` — `…`, with `properties: ["parentId"]`

The store found no mailbox for `parentId`.

## `mailboxHasChild` — `The mailbox has child mailboxes`

Destroy or move the children first: a destroy of a parent and its
children in one call runs in the order of `destroy`, so list the children
first.

## `mailboxHasEmail` — `The mailbox holds emails: set onDestroyRemoveEmails`

The mailbox still holds emails. With `onDestroyRemoveEmails: true` they
leave it, and an email left in no mailbox is destroyed (RFC 8621 §2.5).

## `invalidProperties` — `Only keywords and mailboxIds can be changed`

An email update named another property: the rest of an Email is
immutable (RFC 8621 §4.6).

## `invalidProperties` — `… is an object of keys set to true`

`keywords` or `mailboxIds` given whole is not an object whose every value
is `true`, or holds a key that is not a keyword (printable ASCII but
`( ) { ] % * " \`, at most 255) or an id.

## `invalidPatch` — `… is not a key set to true or null`

A patch `keywords/…` or `mailboxIds/…` set something other than `true`
or `null`, or named a key that is not a keyword or an id.

## `invalidPatch` — `… is patched whole and by key at once`

One update gave both `keywords` and `keywords/$seen` (or the same for
`mailboxIds`). Give one or the other.

## `invalidProperties` — `mailboxIds names at least one mailbox, each of the account`

The update would leave the email in no mailbox, or names a mailbox the
account does not have.

## `invalidProperties` — `An email is created from an uploaded blobId: this property cannot be set`

An `Email/import`, or an `Email/set` create, gave a property other than
`blobId`, `mailboxIds`, `keywords` and `receivedAt`. Building an email
from its properties is not supported yet: build the message (with
`@bumail/mime`'s `buildMessage`), upload it, then import it.

## `invalidProperties` — `blobId is required`

An import, or an `Email/set` create, without `blobId`: upload the
message first and pass the `blobId` the upload answered.

## `invalidProperties` — `mailboxIds names at least one mailbox, each set to true`

A new email's `mailboxIds` is missing, empty, or holds a value other than
`true` or a key that is not an id: `{ "<inboxId>": true }`.

## `invalidProperties` — `keywords is an object of keywords set to true`

A new email's `keywords` is not an object, holds a value other than
`true`, or a key that is not a keyword: `{ "$seen": true }`.

## `invalidProperties` — `receivedAt is a UTCDate`

`receivedAt` is a date such as `2026-10-03T12:00:00Z`.

## `invalidProperties` — `…`, with `properties: ["mailboxIds"]`

The store refused the email: on an import, its first mailbox does not
exist or the content is not one it keeps; on an `Email/set` update that
changes `mailboxIds`, a mailbox it names is gone. The description is the
store's message.

## `invalidProperties` — `…`, with `properties: ["keywords"]`

The store refused an `Email/set` update that changes only `keywords`:
usually a keyword it does not keep. The description is the store's
message.

## `invalidProperties` — `…`, with no properties

The store refused a mailbox destroy for a reason of its own, such as a
mailbox it does not let go. The description is the store's message.

## `blobNotFound` — `No blob has this id`

The `blobId` is not an upload of the account still held (uploads expire
after `uploadTtl`) nor the content of one of its emails. Upload again.
