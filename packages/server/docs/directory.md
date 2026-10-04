# The directory and its commands

The directory says who the server serves: the **domains** it receives
mail for, the **users** who log in and have a mailbox, and the
**aliases** that deliver an address to users. `bumail domain`, `bumail
user` and `bumail alias` manage it; the server reads it at every login
and every recipient. When a command refuses something,
[troubleshooting](troubleshooting.md#the-directory-commands) has an
entry for each message.

- [Where it is](#where-it-is)
- [Addresses, and their case](#addresses-and-their-case)
- [The commands](#the-commands): [`domain`](#bumail-domain), [`user`](#bumail-user), [`alias`](#bumail-alias), [exit codes](#exit-codes)
- [Passwords](#passwords)
- [Logins](#logins): the verify cap, unknown users, the failure limiter
- [Mailboxes in the store](#mailboxes-in-the-store), and removing a user
- [No forwarding](#no-forwarding)
- [From code](#from-code)

## Where it is

One SQLite file, `directory.url` in the configuration, by default
`sqlite:<data>/directory.sqlite`. It is created on first use, readable
by its owner only (0600), in WAL mode: the running server reads it while
a `bumail` command writes it from another process, and a write waits up
to 5 seconds for another.

Every login and every recipient reads the file, so a user added,
disabled or given a new password counts from the next lookup, with no
restart and no reload. Only a verified login is remembered, for a
minute ([the cache](#logins)), and each use of it reads the user's
version in the file, so that holds for it too.

The file carries its schema version in a `schema` table. A server
upgrades an older file when it opens it, in one transaction, and
refuses one written by a newer server.

## Addresses, and their case

The directory keeps every name in lower case, and compares names
without case:

- **Domains** are lowercased, without a trailing dot, and kept in
  A-labels: `Bücher.Example.` is `xn--bcher-kva.example`. An IP
  address (`192.0.2.1`, `[::1]`), a percent-escape (`exa%6dple.com`)
  and a last label of digits or `0x…` hex (`example.123`,
  `example.0x7f`), which URL parsers read as an IPv4 address, are not
  domain names.
- **Local parts** are lowercased too, after Unicode NFC. RFC 5321 lets
  the server that hosts a mailbox decide whether case matters in its
  local parts; here it does not, as no user expects `Alice@` and
  `alice@` to be two people. So `Alice@Example.COM` logs in as
  `alice@example.com`, receives its mail, and no two users or aliases
  differ by case alone.

A local part is a dot-atom of at most 64 octets — letters, digits,
``!#$%&'*+-/=?^_`{|}~``, and any character past ASCII for SMTPUTF8 —
and an address is at most 254 octets. A quoted local part
(`"john doe"@example.com`) is refused.

## The commands

Each runs against the configuration `--config` names (default
`$BUMAIL_CONFIG`, then `/data/bumail.toml`), whose `directory.url` it
opens and, for `user add` and `user remove --purge`, whose `store.url`.
A listing prints nothing when there is nothing to list.

### `bumail domain`

```sh
bumail domain add example.com
# added the domain example.com

bumail domain list
# example.com  2 users, 1 alias
# example.org  0 users, 0 aliases

bumail domain remove example.org
# removed the domain example.org
```

A domain with users or aliases left is not removed: remove them first.

### `bumail user`

```sh
bumail user add alice@example.com
# New password for alice@example.com:
# Again:
# added the user alice@example.com, with its mailboxes

printf '%s\n' "$PASSWORD" | bumail user add bob@example.com --password-stdin
# added the user bob@example.com, with its mailboxes

bumail user add carol@example.com --password-file /run/secrets/carol
# added the user carol@example.com, with its mailboxes

bumail user list
# alice@example.com
# bob@example.com    disabled
# carol@example.com

bumail user list example.com          # one domain's users

bumail user passwd alice@example.com  # prompts, or --password-stdin, --password-file
# changed the password of alice@example.com

bumail user disable bob@example.com
# disabled the user bob@example.com

bumail user enable bob@example.com
# enabled the user bob@example.com

bumail user remove carol@example.com
# removed the user carol@example.com; its mail is kept in the store (bumail user remove --purge deletes it)

bumail user remove carol@example.com --purge
# removed the user carol@example.com and its mail
```

- **The password is never an argument.** Without an option, it is
  typed twice at a prompt that does not echo it. `--password-stdin`
  reads all of standard input, `--password-file <file>` a file (at most
  1 MiB); either drops one final line break. A password on the command
  line — `user add alice@example.com hunter2`, `--password=hunter2` —
  is refused, and not repeated in the refusal.
- The address is checked before the password is asked for, so a typo
  in it costs no typing.
- **Disabled** stops logins only: mail for a disabled user is still
  delivered, so nothing is lost while it is disabled.
- A user an alias points to is not removed: remove the alias first.

### `bumail alias`

```sh
bumail alias add sales@example.com alice@example.com bob@example.com
# added the alias sales@example.com: alice@example.com, bob@example.com

bumail alias list
# sales@example.com  alice@example.com, bob@example.com

bumail alias list example.com         # one domain's aliases

bumail alias remove sales@example.com
# removed the alias sales@example.com
```

An alias is in a domain the server hosts, takes no user's address, and
points to one or more users of this server — never to another alias,
and never to an address elsewhere ([no forwarding](#no-forwarding)). To
change its users, remove it and add it again.

### Exit codes

| code | when |
| --- | --- |
| 0 | done |
| 1 | the configuration is invalid ([its problems](troubleshooting.md)) |
| 2 | bad usage: an unknown command or option, an operand missing or too many, no way to read the password |
| 4 | the directory refused: not an address or a domain, a password refused (too short, too long, typed differently twice, its file unreadable), a name already taken, not found, still in use |
| 5 | the directory or the mail store cannot be opened or used; for `serve`, also a port it cannot bind, the certificate or the spool directory |

(3 is `serve`'s, for `tls.mode = "acme"`.) Errors go to standard error
as `bumail: <message>`. Standard error also carries the password
prompts; standard output carries only what a command reports (`added
the user …`, a listing), and `serve`'s log.

## Passwords

- **Hashing.** Argon2id through `Bun.password`, with 19 MiB of memory
  (`memoryCost` 19456), two passes and one lane: OWASP's recommended
  floor. The hash, in PHC form (`$argon2id$v=19$m=19456,t=2,p=1$…`), is
  all the directory keeps, and nothing exported hands it out.
- **Unicode.** A password is hashed and verified in NFC, as RFC 8265's
  OpaqueString prepares one: `café` typed with a composed `é` or with
  `e` and a combining accent is one password.
- **Length.** At least 12 characters (after NFC), at most 1024 bytes of
  UTF-8, and no control character: no prompt types one, and a stray line
  break from a file would be a password nobody could type.
- **Secrecy.** No output and no error repeats a password: not an
  option's value, not a file's content, and not an operand or a
  command word that could be one. A refused address or domain is
  repeated only when it holds an `@` or a `.`, as a typo does
  (`"alice@example" is not an e-mail address`); otherwise the message
  says `the value given`. An unknown command is named only when it
  reads like one (lowercase letters and hyphens); otherwise `…`.

## Logins

`authenticate(login, password, ip)` checks a login, for the listeners
(SMTP submission, IMAP, JMAP), in this order:

1. **The limiter.** A client that failed too often lately is refused
   at once, as `blocked`, whatever it sends: nothing is verified, so
   guessing on costs the server nothing.
2. **Bounds.** An empty password, or a login or a password over 1024
   bytes, is `malformed`, and refused without a verify; the limiter
   does not count it.
3. **The cache.** A login verified within the last `cacheSeconds` (60)
   is answered at once, without a verify: JMAP authenticates every
   request, and a client sends many at once. It is keyed by the address
   and an HMAC of the password under a key each process draws at
   random, so it holds no password. Every hit reads the user's version
   in the directory, which `user passwd`, `user disable` and `user
   enable` bump and `user remove` deletes, from whichever process: a
   change counts at the very next request, not a minute later.
   `cacheSeconds: 0` turns it off.
4. **Logins under way.** One client has at most `maxPending` (5, and
   never more than `maxFailures`) logins being verified at once, and no
   more than it has failures left before a block; past either, a login
   is `busy`, never `blocked`. So guesses sent all at once get no more
   verified than guesses sent in turn, and a client with the right
   password is never blocked for the logins it has under way.
5. **The verify.** At most **4** run at once; the others wait their
   turn, in order, up to 1000 waiting, past which a login is `busy`
   (the listener answers a temporary failure). Each verify holds
   19 MiB, so the cap keeps a burst of logins from taking the memory
   and CPU the mail needs.
6. **Unknown users cost as much as known ones.** A login that is no
   user — unknown, an alias, not an address — verifies a dummy hash
   made with the same parameters when the directory opens, so the time
   a refusal takes — the first one included — does not tell which
   addresses exist.
7. **The answer**: the user, or `unknown`, `password` (wrong) or
   `disabled` (right, but the user is disabled). A client is told only
   that its login failed; the reason is for the server's log.

### The failure limiter

`FailureLimiter` counts failed logins per client, in memory, shared by
every listener:

- **Who a client is**: an IPv4 address; an IPv6 address that embeds
  one — IPv4-mapped (`::ffff:192.0.2.1`, or `::ffff:c000:201`) or
  NAT64 (`64:ff9b::/96`) — as that IPv4 address; any other IPv6 address
  by its **/64**, which one machine usually holds whole. `clientKey(ip)`
  gives that key, and `undefined` for anything that is no IP address
  (an empty string, a Unix socket path). A login from such a client is
  not limited: there is no client to tell apart, and one bucket for all
  of them would let one guesser block everyone. The first such login
  logs a warning (`onUnlimited` replaces it); a listener behind a proxy
  must pass the client's address.
- **What counts**: every refusal that cost a verify: `unknown`,
  `password` and `disabled`. Tries while blocked are not counted, so
  hammering never extends a block; nor is a `malformed` login, refused
  before any verify and carrying no guess, so it neither blocks a client
  nor keeps one remembered. Every failure counted cost one verify.
- **Logins under way**: at most `maxPending` (5) per client; a
  `maxPending` above `maxFailures` is capped at `maxFailures`. Past it,
  or past the failures a client has left, `begin(ip)` answers `busy`
  instead of `started`, never `blocked`.
- **When it blocks**: at `maxFailures` (10) failures within the last
  `windowSeconds` (900, 15 minutes). The window slides: each failure
  ageing out gives one try back, and a client whose failures are all
  older than the window is forgotten.
- **A success does not clear it**: an attacker who holds one account
  must not reset the count it guesses other accounts under.
- **Memory is bounded**: at most `maxClients` (100 000) are remembered;
  past it, the client below `maxFailures` whose last failure is oldest
  is forgotten. A blocked client is forgotten only when every other one
  is blocked too, and then the one whose block ends soonest. Each block
  takes `maxFailures` counted failures within the window, each of which
  cost a verify, so at most `maxVerifies` ÷ the verify time ×
  `windowSeconds` ÷ `maxFailures` clients are blocked at once. One
  verify measured about 14 ms on a recent laptop core: 4 at once make
  about 290 a second, which with 900 s and 10 failures is about 26 000
  clients, under the default; a slower core verifies fewer. Measure the
  verify time on the machine and keep `maxClients` above that figure,
  and no spray from many addresses can make room by forgetting an
  attacker's block. A restart forgets everything, and each server
  instance counts its own.

## Mailboxes in the store

A user's mail lives in the mail store (`store.url`), in the account
whose login is the user's address, with six mailboxes: `INBOX`, `Sent`,
`Drafts`, `Archive`, `Junk` (where DMARC's quarantine puts mail) and
`Trash`, each with its role. A mailbox that already has one of those
names without its role — a user's own `Junk`, say — is left as it is,
and that role stays missing: the store has no way to give an existing
mailbox a role, and a second `Junk` would be refused.

- `bumail user add` creates them. A SQLite store is held by one process
  at a time, so while the server runs, the command finds it in use, says
  so, and still adds the user: the server creates the account and its
  mailboxes at the user's first login. A PostgreSQL store is open to
  both.
- **Removing a user keeps its mail** — the recommended default. The user
  can no longer log in and its mail is refused, but the account stays in
  the store, so a removal by mistake loses nothing: adding the address
  again finds the same account, with its mail. Add `--purge` to delete
  the account, its mailboxes and its mail too. It disables the user
  first, so no new login creates the account again meanwhile, then
  deletes the mail, then removes the user: a store that fails leaves the
  user in place, disabled, and the same command can run again. A login
  verified just before the disable may still create an empty account
  after the purge; and a user removed without `--purge` leaves its mail.
  Either way, `bumail user remove <address> --purge` with the user gone
  deletes the account left in the store (`… is not a user; deleted its
  account and mail left in the mail store`), and says `the user … does
  not exist` only when the store has none either. With a SQLite store,
  stop the server first, since `--purge` needs the store and refuses
  (exit 5, nothing removed) while the server holds it. Purge before
  giving an old address to someone else.

## No forwarding

An alias points to users of this server only. An alias to an address
elsewhere would make the server a relay: anyone could send to the alias
and have the server pass it on, under its own name, and SPF would fail
for everything forwarded. So the directory refuses such a target, in
any form, and there is no option to allow one — as there is none to
relay without authentication.

## From code

```ts
import {
	Directory,
	directoryFile,
	imapAuthenticate,
	openStore,
	readConfig,
	smtpAuthenticate,
} from '@bumail/server';

const config = await readConfig();
const directory = Directory.open({ file: directoryFile(config.directory.url) });

directory.domains.add('example.com');
await directory.users.add('alice@example.com', 'correct horse battery staple');
directory.aliases.add('sales@example.com', ['alice@example.com']);

directory.domains.has('EXAMPLE.com'); // true: SMTP's localDomains
directory.resolve('Sales@example.com'); // ['alice@example.com']: RCPT TO
directory.resolve('nobody@example.com'); // undefined: refuse it

await directory.authenticate('alice@example.com', 'wrong', '192.0.2.1');
// { ok: false, reason: 'password' }

const { store, close } = openStore(config.store); // close() when the server stops
const smtp = smtpAuthenticate(directory); // @bumail/smtp's authenticate
const imap = imapAuthenticate(directory, store, {
	onRefused: (reason, ip) => console.log(`login refused: ${reason} from ${ip}`),
}); // @bumail/imap's: the store account id, or null
```

`jmapAuthenticate(directory, store, ipOf)` is `@bumail/jmap`'s, given
how to read the client's address from a request (`(request) =>
server.requestIP(request)?.address ?? ''`); it refuses a Bearer token,
which v1 does not issue. Each adapter throws on `busy`, which each
listener answers as a temporary failure (`454`, `NO [UNAVAILABLE]`,
`503`).

`Directory.open` also takes `maxVerifies`, `maxQueuedVerifies`,
`cacheSeconds`, `onUnlimited` and a `limiter`, a `new FailureLimiter({
maxFailures, windowSeconds, maxClients, maxPending })`;
`provisionAccount(store, address)` and `purgeAccount(store, address)`
are what `user add` and `user remove --purge` do to the store.
