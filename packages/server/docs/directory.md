# The directory and its commands

The directory says who the server serves: the **domains** it receives
mail for, the **users** who log in and have a mailbox, and the
**aliases** that deliver an address to users, and each domain's
**DKIM key**. `bumail domain`, `bumail user`, `bumail alias` and
`bumail dkim` manage it, and `bumail dns` prints the DNS records
its domains need; the server reads it at every login
and every recipient. When a command refuses something,
[troubleshooting](troubleshooting.md#the-directory-commands) has an
entry for each message.

- [Where it is](#where-it-is)
- [Addresses, and their case](#addresses-and-their-case)
- [The commands](#the-commands): [`domain`](#bumail-domain), [`user`](#bumail-user), [`alias`](#bumail-alias), [`dkim`](#bumail-dkim), [`dns`](#bumail-dns), [exit codes](#exit-codes)
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

**Before a rollback.** An upgrade is one way. The server that brought
DKIM signing upgrades the file to schema 3, adding the DKIM keys' table,
the first time it or its `bumail` command opens it; a server from before
then refuses that file, and exits 5. To go back, copy the directory
file aside before the upgrade (with the server stopped, or with
`sqlite3 directory.sqlite ".backup …"` while it runs), and restore that
copy with the older server: what changed since, users and keys
included, is lost.

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

A user may send mail as an alias it is one of the users of: alice and
bob may both send as `sales@example.com`.

### `bumail dkim`

```sh
bumail dkim generate example.com
# generated an RSA-2048 DKIM key for example.com, selector bumail; mail from example.com is signed with it from now on
# publish this TXT record:
#   name   bumail._domainkey.example.com
#   value  v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…
# as a zone file line:
#   bumail._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B…" "…"

bumail dkim generate example.com --selector s2 --replace   # a new key, under a new selector
bumail dkim show example.com          # the record again
bumail dkim list
# example.com  selector s2
bumail dkim remove example.com
# removed the DKIM key of example.com; its mail goes unsigned
```

One key per hosted domain, RSA-2048, kept in the directory's file (so
0600, as the password hashes) and never printed: only its record is.
The server signs mail From the domain with it from the next message.
The selector is `bumail` unless `--selector` names another: DNS labels
of letters, digits and hyphens. Removing a domain removes its key.
[Running the server](serve.md#dkim-signing) has how to publish the
record and change keys.

### `bumail dns`

The DNS records the server's domains need, so a deployment is a paste
into your DNS host and one check. It reads the directory and the
configuration, and sends nothing but the queries of `--check`.

```sh
bumail dns --ip 192.0.2.10 --ip6 2001:db8::10    # every hosted domain
bumail dns example.com --ip 192.0.2.10           # one domain
bumail dns --json                                # for a script or an API
bumail dns example.com --check --ip 192.0.2.10   # look each record up in the DNS
```

```text
; DNS records for mail.example.com, and the domains it hosts.
; Publish them at your DNS host, then run bumail dns --check.

; mail.example.com (this server)
mail.example.com. IN A 192.0.2.10
mail.example.com. IN AAAA 2001:db8::10
; optional: mail.example.com. IN CAA 0 issue "letsencrypt.org"
; the reverse DNS (PTR) of 192.0.2.10 should be mail.example.com: it is set at your hosting provider, and many receivers refuse mail without it
; the reverse DNS (PTR) of 2001:db8::10 should be mail.example.com: it is set at your hosting provider, and many receivers refuse mail without it
; the SRV records carry the ports the server listens on: behind Docker port mapping or a proxy, write the public ports instead

; example.com
example.com. IN MX 10 mail.example.com.
example.com. IN TXT "v=spf1 mx -all"
bumail._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…" "…"
_dmarc.example.com. IN TXT "v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com"
_submissions._tcp.example.com. IN SRV 0 1 465 mail.example.com.
_imaps._tcp.example.com. IN SRV 0 1 993 mail.example.com.
_jmap._tcp.example.com. IN SRV 0 1 443 mail.example.com.

; example.org
example.org. IN MX 10 mail.example.com.
example.org. IN TXT "v=spf1 mx -all"
_dmarc.example.org. IN TXT "v=DMARC1; p=none; adkim=s"
_submissions._tcp.example.org. IN SRV 0 1 465 mail.example.com.
_imaps._tcp.example.org. IN SRV 0 1 993 mail.example.com.
_jmap._tcp.example.org. IN SRV 0 1 443 mail.example.com.
; no DKIM key yet: bumail dkim generate example.org makes one, and bumail dns prints its record; until then DMARC is p=none, so nothing is quarantined for lack of a signature
```

The output is a BIND zone file (names absolute, long TXT values split
into strings of 255 bytes), which Cloudflare, Route 53 and most DNS hosts
import as it is; what the server cannot decide is a comment. What it
holds, per domain:

| record | what it is | why |
| --- | --- | --- |
| `MX 10 <hostname>` | the server's `hostname` | mail for the domain comes here |
| `TXT v=spf1 mx -all` | the domain's MX hosts may send for it, nobody else | the server sends from the host its MX names |
| `TXT bumail._domainkey` | the key of `bumail dkim generate`, under its selector | mail is signed with it; with no key, a comment says to make one |
| `TXT _dmarc` | `v=DMARC1; p=quarantine; adkim=s`, and `rua=mailto:postmaster@<domain>` only when the directory has that address; `p=none` while the domain has no DKIM key | see below |
| `SRV _submissions._tcp`, `_imaps._tcp`, `_jmap._tcp` | the submission, IMAP and JMAP ports, for clients that configure themselves from the domain (RFC 6186, RFC 8620 §2.2) | one for each port that is on; JMAP's points to `jmap.origin`'s host and port |

And for the server's host name, once: its **A** and **AAAA** records. The
server cannot know its public address, so they are written from `--ip`
and `--ip6`; without them, a comment reminds you (the IPv6 one is
optional). An **optional CAA** line, commented out, appears with
`tls.mode = "acme"` and Let's Encrypt's directory: it lets only that CA
issue the host name's certificate, and is yours to uncomment. Two more
comments remind you of what no record says: with `--ip`, the **reverse DNS
(PTR)** of the address should be the host name, which only your hosting
provider can set and many receivers insist on; and the **SRV records carry
the ports the server listens on**, so behind Docker port mapping or a
proxy, write the public ports instead. An IP address as `jmap.origin`
cannot be an SRV target, so the `_jmap._tcp` record is left out, with a
comment.

**The DMARC default is `quarantine`, with strict DKIM alignment.**
`p=none` protects no one, and `p=reject` loses real mail while a record is
still wrong, so `quarantine` is the safe place to stand: mail that fails
goes to a spam folder, not away. `adkim=s` is safe because the server
signs with `d=` the From domain, so its own mail always aligns. SPF
alignment stays relaxed (`aspf` is left out): the envelope sender of a
message need not be the From domain itself, a bounce address in a
subdomain for one, and relaxed accepts that. While a domain has **no DKIM
key** the record says `p=none`, since nothing is signed and a policy that
quarantines on a missing signature would be wrong; the comment under it
says to run `bumail dkim generate`, after which `bumail dns` prints
`quarantine`. The `rua=` address is written only when `postmaster@<domain>`
is a user or an alias, so that reports go to a mailbox that exists. They
are XML from the receivers, arrive as ordinary mail in that mailbox, and
the server does not read them for you. With a `[smarthost]`, the SPF
record needs its provider's `include:` added, and the output says so in a
comment.

Not written yet: MTA-STS and TLS-RPT; see the [roadmap](roadmap.md).

**`--json`** prints the same as one JSON object, for a script or a DNS
provider's API: `hostname`, `domains`, `records` (each with `scope`,
`purpose`, `optional`, `name`, `type`, `value` and, for MX and SRV,
`priority`; names without the trailing dot) and `notes` (`scope` and
`message`: what is left to do by hand). With `--check` it adds `checks`,
one per record looked up: the record's fields as above (without
`optional`), and `status`, `found` (what the DNS holds there, as the
record would be written; `[]` when nothing) and, for `unavailable`,
`detail` (why); and `ok`, `true` only when `--check` would exit 0.

**`--check`** looks each record up in the DNS, through `@bumail/dns`, and
reports instead of printing the zone:

```text
mail.example.com
  ok          A    mail.example.com  192.0.2.10
  differs     PTR  192.0.2.10  mail.example.com
                   found  static.provider.example
example.com
  ok          MX   example.com  10 mail.example.com
  duplicate   TXT  example.com  v=spf1 mx -all
                   found  v=spf1 a -all
                   found  v=spf1 mx -all
  missing     TXT  bumail._domainkey.example.com  v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvI11IEUngA…
  differs     TXT  _dmarc.example.com  v=DMARC1; p=quarantine; adkim=s; rua=mailto:postmaster@example.com
                   found  v=DMARC1; p=none
  unchecked   SRV  _submissions._tcp.example.com  1 465 mail.example.com
  unchecked   SRV  _imaps._tcp.example.com  1 993 mail.example.com
  unchecked   SRV  _jmap._tcp.example.com  1 443 mail.example.com

1 missing, 2 differs, 1 duplicate: bumail dns prints what to publish
```

Each record is one of:

- `ok`: it is there.
- `missing`: the DNS has no record of its kind at the name.
- `differs`: it has one, but not this one; `found` says what. A TXT record
  of another kind at the name, such as a site verification, is not a
  difference.
- `duplicate`: two or more SPF records, DMARC records or DKIM key records
  stand at the name. SPF and DMARC receivers answer `permerror` to that,
  whichever is right; a DKIM verifier takes the first key record, so a
  revoked one ahead of the right one revokes it. It fails even when one
  matches: during a key rotation, remove the old record.
- `unavailable`: the DNS gave no answer (the reason is shown), so nothing
  is known about it; try again.
- `unchecked`: not looked up, since `@bumail/dns` has no SRV lookup yet.
  An optional record is never looked up.

SPF, DMARC and DKIM records are compared **as parsed**, as `@bumail/auth`
reads them: white space, case (`V=SPF1`), a leading `+`, a default tag
(`adkim=r`, `k=rsa`) and a value split into several strings do not
matter, but an added `include:`, a different policy or another key do. So
an SPF record you extended on purpose shows as `differs`: that is the
report working. An MX is `ok` when its exchange and preference are among
the answers, in any case and with or without a trailing dot, and the
reverse DNS (PTR) of `--ip` and `--ip6` must name the host name.

The exit code is **0 when every record is there**, **1 when any is
missing, differs or is doubled**, and **5 when the only trouble is a DNS
that did not answer**, so `bumail dns --check` can gate a deploy and a
retry can tell a wrong record from a flaky resolver. Without `--ip`, the
host name only has to resolve to some address, and no PTR is looked up;
`--ip` and `--ip6` also require that address. Answers can lag the change
you made by the record's TTL, and a resolver may cache a negative answer
longer: run it again after a few minutes.

`bumail dns` refuses what is not hosted: `the domain … is not hosted here;
add it first` (exit 4), and with no domain at all, `no domain is hosted
here; bumail domain add adds one`. A stored key it cannot write, which
only a damaged directory holds (an empty one, one that is not base64 or
not an RSA key), is
`the DNS records cannot be written: the stored DKIM key of … is empty`
(or `cannot be used`). `bumail dkim show` refuses it the same way, and
`bumail dkim generate <domain> --replace` mends it.

### Exit codes

| code | when |
| --- | --- |
| 0 | done |
| 1 | the configuration is invalid ([its problems](troubleshooting.md)); for `dns --check`, a record is missing, differs or is doubled |
| 2 | bad usage: an unknown command or option, an operand missing or too many, no way to read the password |
| 4 | the directory refused: not an address or a domain, a `dns` domain that is not hosted, a password refused (too short, too long, typed differently twice, its file unreadable), a name already taken, not found, still in use, a DKIM selector that is no DNS name |
| 5 | the directory or the mail store cannot be opened or used; for `dns --check`, the DNS gave no answer and no record is wrong; for `serve`, also the queue, a port it cannot bind, the certificate or the spool directory |

(3 is reserved: no command returns it.) Errors go to standard error
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
how to read the client's address: `ipOf(request, client)` gets the
`client` `@bumail/jmap` names, the host app's `ctx.ip` — behind its
`trustProxy`, the forwarded client's — so `(_request, client) =>
client?.ip ?? ''` is the usual one; it refuses a Bearer token,
which v1 does not issue. Each adapter throws on `busy`, which each
listener answers as a temporary failure (`454`, `NO [UNAVAILABLE]`,
`503`).

`Directory.open` also takes `maxVerifies`, `maxQueuedVerifies`,
`cacheSeconds`, `onUnlimited` and a `limiter`, a `new FailureLimiter({
maxFailures, windowSeconds, maxClients, maxPending })`;
`provisionAccount(store, address)` and `purgeAccount(store, address)`
are what `user add` and `user remove --purge` do to the store.
