# Troubleshooting: messages

The responses to the commands that read or change messages: APPEND, FETCH,
STORE, SEARCH, COPY and MOVE, and a store call that fails. The
[index](../troubleshooting.md) lists every entry of every page. A tagged
response starts with the client's tag (`a1 NO …`); it is left out here.

## `NO [TOOBIG] The message is over … bytes`

APPEND of a message over `maxMessageSize` (25 MiB), announced as
`APPENDLIMIT`. Raise the option if your store takes larger messages.

## `BAD MULTIAPPEND is not supported`

APPEND takes one message (RFC 3502's MULTIAPPEND is not implemented). With
`{n+}`, the connection is closed, since the next message's bytes follow.

## `BAD Unexpected text after the message`

Something other than the end of the line followed APPEND's message. The
message is not stored.

## `BAD Invalid flag`

APPEND's flag list holds a flag the store does not keep: `\Recent`, a
system flag RFC 9051 does not define (`\Important`), or a keyword over 255
characters. The message is not stored. With `{n}` the answer comes before
the message is sent; with `{n+}`, once its bytes are read. Send the
system flags `\Seen`, `\Answered`, `\Flagged`, `\Deleted` and `\Draft`, or
keywords:

```text
a1 APPEND INBOX (\Seen $Forwarded) {310}
```

STORE of such a flag is answered by the store instead:
[`NO [CANNOT] "…" is not a flag a store keeps`](#no-cannot--is-not-a-flag-a-store-keeps).

## `BAD "…" is not a date-time`

APPEND's date is not an RFC 9051 `date-time`: a quoted
`dd-Mon-yyyy hh:mm:ss +zzzz`, the day one or two digits (a single one
padded with a space), the zone required.

```text
a1 APPEND INBOX "02-Oct-2026 22:00:00 +0000" {310}
a2 APPEND INBOX " 2-Oct-2026 22:00:00 -0700" {310}
```

An ISO date (`"2026-10-02T22:00:00Z"`), a missing zone, or a day that does
not exist (`31-Feb-2026`) gets this. Such an APPEND is not recognised as
one before its message arrives, so the message is read as an ordinary
literal first: past `maxLiteralSize` (64 KiB) the client gets
`BAD [TOOBIG] Literal over … bytes` instead. Fix the date either way.

## `BAD Unknown FETCH item …`

FETCH asked an item this server does not answer, such as `MODSEQ`
(CONDSTORE), `EMAILID` or `X-GM-LABELS`. The items are `FLAGS`, `UID`,
`INTERNALDATE`, `RFC822.SIZE`, `ENVELOPE`, `BODY`, `BODYSTRUCTURE`,
`BODY[…]`, `BODY.PEEK[…]`, `RFC822`, `RFC822.HEADER`, `RFC822.TEXT`, and
the macros `ALL`, `FAST` and `FULL`.

## `BAD Unknown section …`

The text of a `BODY[…]` section is not `HEADER`, `HEADER.FIELDS`,
`HEADER.FIELDS.NOT`, `TEXT` or `MIME`, after the part numbers if any:
`BODY[HEADERS]`, `BODY[1.BODY]`. An empty section, `BODY[]`, is the whole
message.

## `BAD MIME needs a part number`

`BODY[MIME]`: MIME is the header of a part, so it follows a part number,
as in `BODY[1.MIME]` or `BODY[2.1.MIME]` (RFC 9051 §6.4.5). The message's
own header is `BODY[HEADER]`.

## `BAD HEADER.FIELDS needs a field name`

`BODY[HEADER.FIELDS ()]` or `BODY[HEADER.FIELDS.NOT ()]`: the list of
fields is empty. Name one at least:

```text
a1 FETCH 1 BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]
```

## `BAD A partial length is at least 1`

A partial `<origin.length>` with a length of 0, as in `BODY[]<0.0>`. Ask
for one byte at least, or leave the partial out for the whole section.

## `BAD A part number is at least 1`

A section part number of 0, as in `BODY[0]` or `BODY[1.0]`, or one past
4 294 967 295. Parts count from 1; the whole message is `BODY[]`.

## `BAD FETCH modifiers are not supported`, `BAD STORE modifiers are not supported`

`(CHANGEDSINCE …)` and `(UNCHANGEDSINCE …)` are CONDSTORE's, not
implemented yet.

## `BAD BINARY is not supported yet`

`BINARY[…]` (RFC 3516) is not implemented; `BODY[…]` gives the same part,
still encoded.

## `BAD Unknown STORE item …`

STORE takes `FLAGS`, `+FLAGS` or `-FLAGS`, each with `.SILENT` or not
(RFC 9051 §6.4.6). `X-GM-LABELS` and other names are not answered:

```text
a1 STORE 1:3 +FLAGS.SILENT (\Seen)
```

## `NO [CANNOT] "…" is not a flag a store keeps`

The store refused a flag: `\Recent`, or a keyword with characters IMAP
does not allow. The text is the store's.

## `NO [READ-ONLY] The mailbox is read-only`

STORE, EXPUNGE or MOVE after EXAMINE. SELECT the mailbox instead.

## `BAD Unknown search key …, or its argument is missing`

SEARCH ended on a name that is not a key without an argument: either the
key is unknown, or it is one that takes an argument and the argument is
missing, as in `SEARCH FROM`. When an argument does follow an unknown
name, as in `SEARCH X-GM-RAW "x"`, the text is `BAD Unknown search key …`
alone. The [guide](../guide.md#commands) lists the keys; `MODSEQ`,
`OLDER`, `YOUNGER`, `EMAILID` and `THREADID` are not among them.

## `BAD Unsupported SEARCH return option …`

`RETURN (…)` holds an option other than `MIN`, `MAX`, `ALL` and `COUNT`
(RFC 4731): `SAVE` (SEARCHRES, RFC 5182) or `PARTIAL`, say. A client that
reads the capabilities does not send them.

## `BAD Expected a date such as 1-Feb-1994`

`BEFORE`, `ON`, `SINCE`, `SENTBEFORE`, `SENTON` and `SENTSINCE` take a
date as `d-Mon-yyyy` (RFC 9051 §9 `date`), with no time: `SINCE
2026-10-01` or `SINCE "1-Oct-2026 00:00:00 +0000"` get this.

```text
a1 SEARCH SINCE 1-Oct-2026 BEFORE 3-Oct-2026
```

## `BAD More than 32 TEXT or BODY keys in one SEARCH`

TEXT and BODY read each message through, once per key: a SEARCH holds 32
of them at most, counted inside OR, NOT and parentheses too. Search for
fewer strings at a time, or narrow the search first with a date or a
sequence set and search again.

## `NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset`

SEARCH CHARSET other than UTF-8 or US-ASCII.

## `NO [SERVERBUG] Internal error`

A store call failed in an unexpected way. `onError` has the error and the
session.
