# @bumail/server

## 0.2.0

### Minor Changes

- [#85](https://github.com/softistx/bumail/pull/85) [`6e68ec8`](https://github.com/softistx/bumail/commit/6e68ec8667c88eca458de679fa8157c744bd84d9) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `@alxia/core` moves on to `^0.10.0`, with `@bumail/jmap`. Behind a proxy (`jmap.mode = "proxy"`), JMAP now reads `X-Forwarded-Proto` from the entry the outermost trusted proxy wrote, not the right-most: on a chain where every proxy appends (`https, http`), a client that used HTTPS is no longer refused Basic, and one that used plain HTTP no longer passes as TLS. The proxies are read by `@alxia/core`'s `trustProxy` with `untrusted: 'refuse-all'`, `jmap.trusted` as its list: a peer not in it still gets a 403 before anything is read, its body now `{"error":"untrusted_proxy"}` where it was `forbidden`; a chain of trusted proxies alone is counted under its leftmost, and an empty `X-Forwarded-For` entry, like one that is no address, falls back to the peer. `jmapAuthenticate`'s `ipOf` is given the `client` jmap names as a second argument (`JmapLoginClient`).

### Patch Changes

- [#81](https://github.com/softistx/bumail/pull/81) [`2669c05`](https://github.com/softistx/bumail/commit/2669c0586ec3633ae3b3891be33b30a31ccf7886) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `bumail init` prints its next steps with the `--config` it was given, quoted for the shell when needed, so they reach the file it wrote outside the image too.

- [#83](https://github.com/softistx/bumail/pull/83) [`7f72784`](https://github.com/softistx/bumail/commit/7f727841f34553a595c47b37e3cf27a767eb070d) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `@alxia/core` moves from `^0.3.1` to `^0.7.0`, with `@bumail/jmap`. JMAP on 443 answers as before.

- [#84](https://github.com/softistx/bumail/pull/84) [`d218b39`](https://github.com/softistx/bumail/commit/d218b391f62bd3dc605c66bd1d6c8eac23ce5333) Thanks [@SteveGT96](https://github.com/SteveGT96)! - `@alxia/core` moves on to `^0.9.0`, with `@bumail/jmap`. JMAP on 443 answers a request with the wrong method and no valid credentials with a 401 where it answered a 405; such a request with a wrong password counts as a failed login for the client's limiter, as on the right method.
- Updated dependencies [[`6e68ec8`](https://github.com/softistx/bumail/commit/6e68ec8667c88eca458de679fa8157c744bd84d9), [`7f72784`](https://github.com/softistx/bumail/commit/7f727841f34553a595c47b37e3cf27a767eb070d), [`d218b39`](https://github.com/softistx/bumail/commit/d218b391f62bd3dc605c66bd1d6c8eac23ce5333)]:
  - @bumail/jmap@0.4.0

## 0.1.0

### Minor Changes

- [#79](https://github.com/softistx/bumail/pull/79) [`6ba3b05`](https://github.com/softistx/bumail/commit/6ba3b052916a7c8ce77d1c7c880f4c252eeee0a4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The first release of the bumail mail server, as the `bumail` command (it runs on Bun 1.4.2 or later: `bunx @bumail/server --help`) and as the Docker image `ghcr.io/softistx/bumail`. One TOML file configures it, and `bumail init` writes the starter one. It receives mail on port 25 (SPF, DKIM and DMARC checked, never an open relay), sends its users' mail from 465 and 587 (AUTH only after TLS, DKIM-signed) through its queue, by MX or a smarthost, and serves the mailboxes over IMAP on 993 and over JMAP on 443. Its certificate comes from files, or is obtained from an ACME CA by HTTP-01 and renewed. `bumail domain`, `user`, `alias` and `dkim` manage its directory, `bumail dns` prints the DNS records every hosted domain needs and checks them, and `bumail health` is the image's health check. Behind a reverse proxy such as Traefik it takes plain HTTP and the PROXY protocol from the proxies you list.
