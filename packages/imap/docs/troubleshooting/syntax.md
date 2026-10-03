# Troubleshooting: command syntax

The `BAD`s a command gets before it runs: its tag and name, its state, the
size of its line and literals, and the grammar every command shares —
strings, numbers, lists and sequence sets. The
[index](../troubleshooting.md) lists every entry of every page. A tagged
response starts with the client's tag (`a1 BAD …`); it is left out here.

A `BAD` means the server did not run the command: nothing changed. The
connection goes on, and the client may send the next command.

## `* BAD Missing or invalid tag`

The line did not start with a tag: it was empty, it began with a space
or with a character no tag holds — one of `(){%*"\` — or its tag held a
`+`. The answer is untagged since there is no tag to answer with.
A hand-typed session that forgets the tag gets this:

```text
C: LOGIN alice secret
S: * BAD Missing or invalid tag
C: a1 LOGIN alice secret
```

## `BAD Missing command`

The line held a tag and nothing else, or the tag was not followed by a
space: in `a(1 NOOP` the tag is `a`, and `(` is not a space. A stray `DONE` sent after IDLE has already ended reads as a
tag `DONE` with no command, and gets `DONE BAD Missing command`.

## `BAD … is not valid in the … state`

The command does not belong to the session's state: FETCH before SELECT,
SELECT before logging in, LOGIN after it.

## `BAD Unknown command …`

The command is not one this server implements; the
[guide](../guide.md#commands) lists them. `UID` goes only before FETCH,
STORE, COPY, MOVE, SEARCH and EXPUNGE.

## `BAD Command line too long`

A line over 64 KiB. Long values go as literals; a client that builds huge
sequence sets can send ranges (`1:500`) instead. A line too long that
announced a `{n+}` literal closes the connection instead
(`* BYE Command line too long, closing`), since its bytes would be read
as commands.

## `BAD [TOOBIG] Literal over … bytes`

A literal of a command other than APPEND over `maxLiteralSize` (64 KiB).
The server answers before the bytes are sent. For `{n+}`, whose bytes
follow at once, it closes the connection instead:
`* BYE [TOOBIG] Literal over … bytes, closing`.

## `BAD More than 32 literals in one command`

No command this server implements needs more. When the 33rd is a `{n+}`
literal, whose bytes follow unasked, the connection is closed instead:

```text
* BYE More than 32 literals in one command, closing
```

## `BAD [TOOBIG] Literal over 1024 bytes before login`

Before login, a literal is at most 1 KiB, whatever `maxLiteralSize` says:
only LOGIN takes strings then, and a user name or a password is shorter.
It is the bound LITERAL- (RFC 7888) sets, so a connection nobody has
authenticated holds a few KiB of the server, not megabytes. For `{n+}` the
connection closes instead:
`* BYE [TOOBIG] Literal over 1024 bytes before login, closing`. A client
sending a longer password as a literal should log in with AUTHENTICATE
PLAIN, whose response is a line of base64.

## `BAD More than 2 literals before login`

A command sent before login announced a third literal: LOGIN needs two at
most, the user name and the password. For `{n+}` the connection closes
instead: `* BYE More than 2 literals before login, closing`.

## `BAD Lists nest too deep` and `BAD Search keys nest too deep`

Parentheses, or `NOT` and `OR`, nested more than 32 deep.

## `BAD Expected …`

The parser wanted one element of the grammar and found something else.
The text names what it wanted:

| text | where |
| --- | --- |
| `Expected a space` | an argument is missing: the line ended, or something else came, where a space and the next argument go |
| `Expected "("`, `Expected ")"` | a parenthesised list: its opening, or its end after the last item |
| `Expected "["`, `Expected "]"`, `Expected "."`, `Expected ">"` | a FETCH `BODY[section]<origin.length>` |
| `Expected a command` | the command name after the tag, or after `UID` |
| `Expected an atom or a string` | a mailbox name, a username, a password, a header field: an atom, a `"quoted"` string or a `{literal}` |
| `Expected a mailbox pattern` | LIST and LSUB's pattern |
| `Expected a flag` | a flag in STORE or APPEND: `\Seen` or a keyword; `\*` is only for PERMANENTFLAGS |
| `Expected a keyword` | SEARCH `KEYWORD` and `UNKEYWORD` |
| `Expected a name` | a FETCH item or a SEARCH key, such as a stray `(` or `$` |
| `Expected a number` | digits, at most ten of them: SEARCH `LARGER`, a partial `<0.100>` |
| `Expected a sequence set` | `1`, `2:4`, `5:*` or `1,3:5`; `0`, `1:` and `,2` are not |
| `Expected a UID set` | the same, after `UID` in SEARCH, or for UID EXPUNGE |
| `Expected a capability` | ENABLE's names |
| `Expected a SASL mechanism`, `Expected an initial response` | AUTHENTICATE's arguments |
| `Expected a STATUS item`, `Expected a selection option`, `Expected a return option` | STATUS, LIST and SEARCH's lists of options |

Compare the command with the grammar of RFC 9051 §9; a protocol trace
from the client shows the exact line. `Expected RETURN`, `Expected DONE`
and `Expected a date such as 1-Feb-1994` have entries of their own.

## `BAD Unexpected text at the end of the command`

The command was complete, and more followed on the line: an argument too
many, a trailing space, or a modifier this server does not implement.
CAPABILITY, NOOP, LOGOUT and the other commands without arguments get it
for any text after their name.

## `BAD Unterminated quoted string`, `BAD A quoted string cannot hold a CR`, `BAD A quoted string escapes only " and \`

A `"quoted"` string ends at its closing quote, on the same line; inside it,
a backslash escapes only `"` and `\` (RFC 9051 §4.3). A value with a line
break, or that the client cannot escape, goes as a literal instead:

```text
a1 LOGIN alice "pass\"word"
a2 LOGIN alice {9+}
pass"word
```

## `BAD A literal ends its line: {size}`

A `{n}` or `{n+}` marker can only end a line, its bytes following on the
next one; this one had text after it, or a `{` where no literal can go.

## `BAD A number is at most 4294967295`

A number past 2^32 − 1, the largest IMAP has (RFC 9051 §9): a SEARCH
`LARGER` or a partial's origin, say.

## `BAD No such message`

A sequence number past the last message of the mailbox (RFC 9051 §6.4.4).
The client's view is stale: a NOOP brings it up to date.

## `BAD $ (SEARCHRES) is not supported`

`$`, the saved search result of RFC 5182, is not implemented: a sequence
set such as `$` or `1:$` in FETCH, STORE, COPY, MOVE, UID EXPUNGE or a
`UID` search key gets this. `SEARCH $`, where `$` stands where a search
key would, gets `BAD Expected a name` instead. Clients use `$` only when
the server advertises `SEARCHRES`, which this one does not.
