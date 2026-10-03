# @bumail/imap

An IMAP server for Bun, on `Bun.listen`: IMAP4rev2 (RFC 9051), with
IMAP4rev1 clients served too; STARTTLS or implicit TLS; LOGIN and
AUTHENTICATE PLAIN, only once encrypted; IDLE, MOVE, SPECIAL-USE,
LIST-EXTENDED, ESEARCH and LITERAL+. It serves the mail of any
[`@bumail/store`](https://github.com/softistx/bumail/blob/develop/packages/store) `MailStore`, and reads messages with
[`@bumail/mime`](https://github.com/softistx/bumail/blob/develop/packages/mime). Thunderbird and Apple Mail log in, list
folders, read messages and set flags.

```sh
bun add @bumail/imap @bumail/store @bumail/mime
```

`@bumail/store` and `@bumail/mime` are peers: install the versions your app
uses. `typescript` is an optional peer, for the types.

## Serving a store on 143 and 993

The `authenticate` hook is how users log in: it gets the credentials and
answers the id of the store account to serve, or `null` to refuse. It is
asked only over TLS.

```ts
import { createImapServer } from '@bumail/imap';
import { MemoryMailStore } from '@bumail/store';

const store = new MemoryMailStore();
const alice = await store.createAccount('alice@example.com');
await store.createMailbox(alice.id, { name: 'INBOX', role: 'inbox' });
await store.createMailbox(alice.id, { name: 'Sent', role: 'sent' });
await store.createMailbox(alice.id, { name: 'Archive', role: 'archive' });

const passwords = new Map([['alice', await Bun.password.hash('correct horse')]]);
const accounts = new Map([['alice', alice.id]]);

const options = {
	hostname: 'imap.example.com',
	store,
	tls: {
		key: await Bun.file('/etc/ssl/imap.example.com.key').text(),
		cert: await Bun.file('/etc/ssl/imap.example.com.crt').text(),
	},
	async authenticate({ username, password }) {
		const hash = passwords.get(username);
		if (!hash || !(await Bun.password.verify(password, hash))) return null;
		return accounts.get(username) ?? null;
	},
};

// 143: clear at first, STARTTLS before logging in.
await createImapServer(options).listen({ port: 143 });
// 993: TLS from the first byte (RFC 8314), what most clients pick.
await createImapServer({ ...options, implicitTls: true }).listen({ port: 993 });
```

Mail delivered into the store (by `@bumail/smtp`'s `onData`, say) reaches
a client in IDLE within `idleInterval` seconds (10 by default). Call
`server.notify(accountId)` after a delivery for it to arrive at once.

## Trying it with Thunderbird

1. Run the server above with a certificate Thunderbird trusts — or, for a
   local try, a self-signed one for `localhost`, accepting Thunderbird's
   security exception when it asks.
2. *Account Settings → Account Actions → Add Mail Account*, then
   *Configure manually*.
3. Incoming: IMAP, host `localhost`, port `993` with *SSL/TLS*, or `143`
   with *STARTTLS*; authentication *Normal password*; username `alice`.
4. Thunderbird lists INBOX, Sent and Archive with their special-use
   roles, reads the messages, marks them read, and moves them to Archive.

Apple Mail is the same: IMAP, port 993, *Use TLS/SSL*, *Password*
authentication.

## Limits

| option | default | |
| --- | --- | --- |
| `maxConnections` | 1000 | one more gets `* BYE [UNAVAILABLE] Too many connections, try later` |
| `maxMessageSize` | 25 MiB | the largest APPEND, announced as `APPENDLIMIT`; streamed into the store, never held |
| `maxLiteralSize` | 64 KiB | the largest literal of any other command |
| `timeout` | 1800 s | idle seconds before the server hangs up; at least 1800 (RFC 9051 §5.4) |
| `loginTimeout` | 60 s | from connecting to logged in, however much the client sends |
| `idleInterval` | 10 s | between two looks at the store during IDLE |
| `hookTimeout` | 60 s | for `authenticate` to settle |

Every timer is at most 2 147 483 seconds, what `setTimeout` can wait. A
command line is at most 64 KiB, with at most 32 literals and lists or
search keys nested at most 32 deep. A sequence set such as `1:4294967295`
is resolved from its ranges, never expanded.

## Traps

- **LOGIN only after TLS.** On a clear connection the server advertises
  `LOGINDISABLED` and answers `NO [PRIVACYREQUIRED]` to LOGIN and
  AUTHENTICATE without reading the password. `tls` is required for that
  reason; there is no option to log in in clear.
- **No CONDSTORE or QRESYNC yet.** A client resynchronises a mailbox by
  fetching its flags; `ENABLE CONDSTORE` is answered without it.
- **No UIDPLUS yet.** APPEND, COPY and MOVE do not say the new UIDs; a
  client finds them with UID SEARCH or a FETCH.
- **SEARCH TEXT and BODY read the stored bytes.** A base64 or
  quoted-printable body is not decoded before matching.
- **A sequence number past the last message is `BAD`,** as RFC 9051
  §6.4.4 says; a UID set that names no message is not.

## API

| export | |
| --- | --- |
| `createImapServer(options)` | the server; throws an `ImapError` (`INVALID_OPTION`) on a bad option |
| `ImapServer` | `listen({ port, hostname? })` (once; again throws `ALREADY_LISTENING`), `stop(closeConnections?)`, `notify(accountId)` to wake the account's IDLE sessions, `connections` |
| `ImapServerOptions` | `hostname`, `store`, `tls`, `implicitTls`, `authenticate`, the limits above, `onError` |
| `ImapSession` | what `authenticate` and `onError` receive: `id`, `remoteAddress`, `secure`, `user`, `accountId`, and `data` for your own state |
| `AuthResult` | what `authenticate` answers: an account id, or `null` / `undefined` to refuse |
| `Credentials` | what `authenticate` receives: `mechanism` (`LOGIN` or `PLAIN`), `username`, `password`, `authorizationId?` |
| `TlsOptions` | `key` and `cert`, as `Bun.listen` takes them |
| `ImapError`, `ImapErrorCode` | `code`: `INVALID_OPTION`, `ALREADY_LISTENING`, and `HOOK_TIMEOUT`, which `onError` gets |
| `encodeUtf7(name)`, `decodeUtf7(name)` | mailbox names to and from modified UTF-7 (RFC 3501 §5.1.3), as IMAP4rev1 clients write them |

## Documentation

- [Index](https://github.com/softistx/bumail/blob/develop/packages/imap/docs/README.md): the pages, and when to read each.
- [Guide](https://github.com/softistx/bumail/blob/develop/packages/imap/docs/guide.md): the session, every command, how the store maps to IMAP, IDLE and `notify`, the RFCs followed and what is not.
- [Troubleshooting](https://github.com/softistx/bumail/blob/develop/packages/imap/docs/troubleshooting.md): every error, and the responses a client reports.
- [Roadmap](https://github.com/softistx/bumail/blob/develop/packages/imap/docs/roadmap.md): what is coming — CONDSTORE, QRESYNC, UIDPLUS, BINARY — and what is not planned.

## License

MIT
