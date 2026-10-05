# @bumail/server

## 0.1.0

### Minor Changes

- [#79](https://github.com/softistx/bumail/pull/79) [`6ba3b05`](https://github.com/softistx/bumail/commit/6ba3b052916a7c8ce77d1c7c880f4c252eeee0a4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - The first release of the bumail mail server, as the `bumail` command (it runs on Bun 1.4.2 or later: `bunx @bumail/server --help`) and as the Docker image `ghcr.io/softistx/bumail`. One TOML file configures it, and `bumail init` writes the starter one. It receives mail on port 25 (SPF, DKIM and DMARC checked, never an open relay), sends its users' mail from 465 and 587 (AUTH only after TLS, DKIM-signed) through its queue, by MX or a smarthost, and serves the mailboxes over IMAP on 993 and over JMAP on 443. Its certificate comes from files, or is obtained from an ACME CA by HTTP-01 and renewed. `bumail domain`, `user`, `alias` and `dkim` manage its directory, `bumail dns` prints the DNS records every hosted domain needs and checks them, and `bumail health` is the image's health check. Behind a reverse proxy such as Traefik it takes plain HTTP and the PROXY protocol from the proxies you list.
