# Troubleshooting: mailboxes

The responses to the commands that name a mailbox: SELECT and EXAMINE,
CREATE, DELETE, RENAME, SUBSCRIBE, STATUS, LIST and LSUB, and the target
of COPY, MOVE and APPEND. The [index](../troubleshooting.md) lists every
entry of every page. A tagged response starts with the client's tag
(`a1 NO …`); it is left out here.

## `BAD "…" is not a valid modified UTF-7 mailbox name`

An IMAP4rev1 session writes a mailbox name that is not ASCII in modified
UTF-7 (RFC 3501 §5.1.3), and this name did not decode: an `&` that does
not start a valid `&…-` run, such as `R&D` (which is written `R&-D`).
The client meant the name in UTF-8: it should send `ENABLE IMAP4rev2`
first, after which names travel in UTF-8, or encode it. The `…` is the
name as the client sent it, cut after 100 characters (`...`), with any
control character — a CR or LF in a literal — left out: client text never
goes back raw, so it cannot end the line and forge a response. `encodeUtf7` gives
the form a rev1 client should send:

```ts
import { encodeUtf7 } from '@bumail/imap';
encodeUtf7('R&D'); // 'R&-D'
```

## `BAD "…" has an empty level`

CREATE or RENAME to a name with two delimiters in a row, or one at the
start: `Work//2026`, `/Work`. One trailing delimiter is dropped
(`Work/` creates `Work`, RFC 9051 §6.3.4); an empty level in the middle
is not a name the store can keep. As everywhere a response repeats the
client's text, the name is cut after 100 characters, control characters
left out.

## `NO [LIMIT] A mailbox name has at most 32 levels`

CREATE or RENAME to a name 33 levels deep or more: `a/b/c/…`. Every look
at the account's mailboxes — LIST, SELECT, STATUS, each command naming
one — builds each mailbox's full name from its parents, so a deep tree
costs every later command. Mail clients nest a handful of levels; one
that hits this is generating names. Flatten the hierarchy.

## `NO [LIMIT] A mailbox name is at most 1024 characters`

CREATE or RENAME to a name over 1024 characters, every level and
delimiter counted. LIST's patterns have the same bound
([`BAD The pattern is too long`](#bad-the-pattern-is-too-long)). Use a
shorter name.

## `NO [LIMIT] A level of a mailbox name is at most 255 characters`

CREATE or RENAME to a name with one level over 255 characters, such as
`Projects/<300 characters>`: a store keeps a mailbox name of 255
characters at most, and each level is one mailbox. The name is refused
whole, before any missing parent is created, so nothing is left behind.
Shorten that level, or split it in two.

## `NO [CANNOT] A level of a mailbox name cannot begin or end with white space`

CREATE or RENAME to a name with a level that starts or ends with white
space, or is nothing but white space: `"Work/ /2026"`, `"Work/ Notes"`,
`"Work "`. A store trims each mailbox name, so `" Notes"` would be kept
as `Notes`, another name than the one asked for, and `" "` not at all.
The name is refused whole, before any missing parent is created, so
nothing is left behind. White space inside a level is fine:
`"Work/Q1 notes"`. Drop the spaces at either end of each level.

## `NO [CANNOT] A mailbox name cannot hold a control character`

CREATE or RENAME to a name holding a character below U+0020, or U+007F:
a tab inside a level, or one written in modified UTF-7 (`Work/&AAE-`),
or sent raw in a literal after `ENABLE IMAP4rev2`. A store keeps no
control character in a mailbox name. The name is refused whole, before
any missing parent is created. Use a name without one.

## `BAD CREATE parameters are not supported`

CREATE with a parenthesised list after the name, such as
`CREATE Sent (USE (\Sent))` of RFC 6154's CREATE-SPECIAL-USE, which this
server does not advertise. Create the mailbox without it; a role is given
in the store (`createMailbox(accountId, { name, role })`).

## `BAD SELECT parameters are not supported`, `BAD EXAMINE parameters are not supported`

SELECT or EXAMINE with a list after the name, such as `(CONDSTORE)` or
`(QRESYNC (…))` (RFC 7162), not implemented yet: the
[roadmap](../roadmap.md) has them. A client that checks the capabilities
does not send them.

## `BAD Unknown STATUS item …`

STATUS, or LIST's `RETURN (STATUS (…))`, asked an item this server does
not answer: `HIGHESTMODSEQ` (CONDSTORE), `APPENDLIMIT`, `MAILBOXID`… The
items are `MESSAGES`, `UIDNEXT`, `UIDVALIDITY`, `UNSEEN`, `SIZE`,
`DELETED` and `RECENT`.

## `BAD STATUS needs at least one item`

`STATUS INBOX ()`: the list of items is empty. Ask for one at least:

```text
a1 STATUS INBOX (MESSAGES UNSEEN)
```

## `BAD Unknown LIST selection option …`

The list before the reference holds an option other than `SUBSCRIBED`,
`REMOTE`, `RECURSIVEMATCH` and `SPECIAL-USE` (RFC 5258, RFC 6154).
`CHILDREN` and `STATUS` are return options: they go after `RETURN`.

## `BAD Unknown LIST return option …`

`RETURN (…)` holds an option other than `SUBSCRIBED`, `CHILDREN`,
`SPECIAL-USE` and `STATUS (…)` (RFC 5258, 6154, 5819): `MYRIGHTS` or
`METADATA`, say, of extensions this server does not have.

## `BAD RECURSIVEMATCH needs another selection option (RFC 5258 §3)`

`LIST (RECURSIVEMATCH) "" *`: RECURSIVEMATCH changes what another
selection option matches, and means nothing alone. Pair it:

```text
a1 LIST (SUBSCRIBED RECURSIVEMATCH) "" *
```

## `BAD Expected RETURN`

After LIST's patterns only `RETURN (…)` may follow; another word came, or
a list without the word `RETURN` before it.

## `BAD The pattern is too long`

The reference and the pattern of LIST or LSUB, once joined, are over 1024
characters. No mailbox name is that long; the client built the pattern
wrong.

## `BAD More than 16 patterns in one LIST`

LIST-EXTENDED (RFC 5258 §3) lets a LIST carry a list of patterns, `LIST ""
(INBOX Work/* %)`; this server takes 16 at most, since each one is matched
against every mailbox. Send several LISTs, or one pattern that covers
them: `*` lists everything.

## `NO [NONEXISTENT] No such mailbox`

SELECT, EXAMINE, STATUS, DELETE, RENAME or SUBSCRIBE of a name the
account does not have. Names are case-sensitive, except INBOX.

## `NO [TRYCREATE] No such mailbox`

COPY, MOVE or APPEND to a mailbox that does not exist. The client may
CREATE it and try again.

## `NO [ALREADYEXISTS] The mailbox already exists`

CREATE of a name the account already has. INBOX is matched in any case:
`CREATE inbox` gets this too once INBOX exists.

## `NO [ALREADYEXISTS] The new name is taken`

RENAME to a name another mailbox has. Pick another name, or DELETE that
mailbox first if it is the one to replace:

```text
a1 RENAME Drafts Old/Drafts
```

## `NO [CANNOT] INBOX cannot be deleted`

INBOX is where new mail goes; it stays.

## `NO [CANNOT] Delete the mailboxes inside it first`

DELETE of a mailbox with children. The store does not keep a mailbox that
only holds others (`\Noselect`), so the children go first.

## `NO [INUSE] The mailbox is selected: close it first`

DELETE of the mailbox this session has selected. CLOSE or UNSELECT, then
DELETE.

## `NO [CANNOT] Renaming INBOX is not supported`

RFC 9051 has RENAME INBOX move its messages to a new mailbox; that is not
implemented. Create the mailbox and MOVE the messages.

## `NO [CANNOT] A mailbox cannot move inside itself`

RENAME of `a` to `a/b`.

## A store's own refusal: `NO [NONEXISTENT] …`, `NO [ALREADYEXISTS] …`, `NO [CANNOT] …`

The server checked the command, but the store refused it, often because
another session changed the account in between: a mailbox deleted, a name
taken. The `StoreError`'s code becomes the response code — `NOT_FOUND`
is `NONEXISTENT`, `ALREADY_EXISTS` is `ALREADYEXISTS`, `INVALID` is
`CANNOT` — and its message follows, cut after 200 characters (`...`),
control characters left out. Search
[`@bumail/store`'s troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/store/docs/troubleshooting.md)
for the text after the code. Any other failure, a `StoreError` of another
code included, gets
[`NO [SERVERBUG] Internal error`](messages.md#no-serverbug-internal-error)
and goes to `onError`.
