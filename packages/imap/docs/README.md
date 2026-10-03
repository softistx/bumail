# @bumail/imap documentation

The [package README](../README.md) is the short version. This folder is the
long one.

| Page | Read it when |
| --- | --- |
| [Guide](guide.md) | running the server on 143 or 993; writing `authenticate`; knowing which commands and extensions a client gets, in which state; how mailboxes, flags and UIDs of the store appear over IMAP; how new mail reaches IDLE; setting the limits; or checking which RFC a behaviour follows |
| [Troubleshooting](troubleshooting.md) | you have an error's text and want its entry: the index of every entry, by its exact text |
| [Troubleshooting: configuration and onError](troubleshooting/configuration.md) | `createImapServer` threw, the server will not listen, or `onError` was called |
| [Troubleshooting: logging in, connections and IDLE](troubleshooting/connections.md) | a client cannot log in, was disconnected with a `BYE`, or IDLE ended with a `BAD` |
| [Troubleshooting: command syntax](troubleshooting/syntax.md) | a command got a `BAD` for its tag, its state, its size or its grammar |
| [Troubleshooting: mailboxes](troubleshooting/mailboxes.md) | SELECT, CREATE, DELETE, RENAME, STATUS or LIST got a `BAD` or a `NO` |
| [Troubleshooting: messages](troubleshooting/messages.md) | APPEND, FETCH, STORE, SEARCH, COPY or MOVE got a `BAD` or a `NO` |
| [Roadmap](roadmap.md) | wondering what is coming — CONDSTORE and QRESYNC, UIDPLUS, BINARY — and what is not planned |
