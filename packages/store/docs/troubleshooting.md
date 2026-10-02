# Troubleshooting

Each entry is headed by the message of the `StoreError` thrown. The parts
in quotes vary.

**NOT_FOUND**

- [`StoreError: No account "…"`](#storeerror-no-account-)
- [`StoreError: No mailbox "…"`](#storeerror-no-mailbox-)
- [`StoreError: No message "…"`](#storeerror-no-message-)

**ALREADY_EXISTS**

- [`StoreError: An account "…" already exists`](#storeerror-an-account--already-exists)
- [`StoreError: A mailbox "…" already exists there`](#storeerror-a-mailbox--already-exists-there)
- [`StoreError: The account already has a mailbox with the role …`](#storeerror-the-account-already-has-a-mailbox-with-the-role-)

**INVALID**

- [`StoreError: An account needs a name`](#storeerror-an-account-needs-a-name)
- [`StoreError: "…" is not a mailbox name`](#storeerror--is-not-a-mailbox-name)
- [`StoreError: A parent mailbox must be in the same account`](#storeerror-a-parent-mailbox-must-be-in-the-same-account)
- [`StoreError: A mailbox cannot be inside itself`](#storeerror-a-mailbox-cannot-be-inside-itself)
- [`StoreError: Only an empty mailbox can be deleted`](#storeerror-only-an-empty-mailbox-can-be-deleted)
- [`StoreError: A mailbox with children cannot be deleted`](#storeerror-a-mailbox-with-children-cannot-be-deleted)
- [`StoreError: "…" is not a flag a store keeps`](#storeerror--is-not-a-flag-a-store-keeps)
- [`StoreError: Messages can only be copied within their account`](#storeerror-messages-can-only-be-copied-within-their-account)

## `StoreError: No account "…"`

**When**: a method was given an account id that names no account — never
created, or deleted.

**Fix**: look the account up with `findAccount(login)` or `getAccount(id)`,
which return `undefined` instead of throwing.

## `StoreError: No mailbox "…"`

**When**: a mailbox id names no mailbox: `addMessage`, `listMessages`,
`renameMailbox`, `deleteMailbox`, a copy or move target, or a `parentId`.

**Fix**: `getMailbox(id)` or `findMailbox(accountId, role)` first; both
return `undefined` for none.

## `StoreError: No message "…"`

**When**: `setFlags`, `copyMessages`, `moveMessages` or `removeMessages`
was given the id of a message that is gone — removed, or moved, which
gives the message a new id. Nothing is changed: the call checks every id
before it acts.

**Fix**: after a move, use the ids it returned.

## `StoreError: An account "…" already exists`

**When**: `createAccount` with a login another account has, in any case.

**Fix**: `findAccount(login)` first.

## `StoreError: A mailbox "…" already exists there`

**When**: `createMailbox` or `renameMailbox` with a name another mailbox
has under the same parent. Names compare exactly: `Work` and `work` are
two mailboxes.

## `StoreError: The account already has a mailbox with the role …`

**When**: `createMailbox` with a role — `inbox`, `sent`… — another mailbox
of the account has. A role is unique per account.

**Fix**: `findMailbox(accountId, role)` first.

## `StoreError: An account needs a name`

**When**: `createAccount` with an empty or blank login.

## `StoreError: "…" is not a mailbox name`

**When**: a mailbox name that is empty, blank, or holds a control
character (U+0000 to U+001F, U+007F).

## `StoreError: A parent mailbox must be in the same account`

**When**: a `parentId` names another account's mailbox.

## `StoreError: A mailbox cannot be inside itself`

**When**: `renameMailbox` with a `parentId` that is the mailbox itself or
one of its descendants.

## `StoreError: Only an empty mailbox can be deleted`

**When**: `deleteMailbox` on a mailbox that holds messages.

**Fix**: move or remove its messages first.

## `StoreError: A mailbox with children cannot be deleted`

**When**: `deleteMailbox` on a mailbox that is the parent of others.

**Fix**: delete or move its children first.

## `StoreError: "…" is not a flag a store keeps`

**When**: a flag that is neither one of the five system flags nor a
keyword: `\Recent` (gone in IMAP4rev2), an unknown `\Something`, or a word
with white space, a control character, `(`, `)`, `{`, `%`, `*`, `"`, `\`
or `]`.

**Fix**: use `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`, or a
keyword such as `$Forwarded`.

## `StoreError: Messages can only be copied within their account`

**When**: `copyMessages` or `moveMessages` to another account's mailbox.
Nothing is copied or removed.

**Fix**: read the content with `readContent` and `addMessage` it to the
other account.
