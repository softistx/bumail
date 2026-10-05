# Deploying with Docker

One image holds the whole server, and one volume holds everything it
keeps. This page takes a fresh Linux host with Docker to a mail server
that receives, sends and serves mail, in seven steps, then covers
running it behind Traefik, upgrades, backups, logs and the firewall.

- [What you need](#what-you-need)
- [Choose a variant](#choose-a-variant)
- [Deploy in 7 steps](#deploy-in-7-steps)
- [Behind Traefik](#behind-traefik)
- [Behind Traefik, mail ports included: TCP routers and the PROXY protocol](#behind-traefik-mail-ports-included-tcp-routers-and-the-proxy-protocol)
- [Upgrades](#upgrades)
- [Backups](#backups)
- [Logs](#logs)
- [The firewall](#the-firewall)
- [Secrets](#secrets)
- [What the image holds](#what-the-image-holds)
- [Checked end to end](#checked-end-to-end)

## What you need

- A Linux host with a public IPv4 address, **Docker 25 or later with
  Compose v2.24 or later** (`docker compose version`), and root or a
  user in the `docker` group.
- A domain whose DNS you can edit, and the name the server will have
  (this page uses `mail.example.com` for the server and `example.com`
  for the domain it hosts).
- **Reverse DNS (a PTR record)** on the host's address, naming
  `mail.example.com`, set at your hosting provider. Many receivers refuse
  mail from an address without one.
- **Outbound port 25 open.** Many cloud hosts and home connections block
  it; the server then cannot deliver to other servers. Ask the provider
  to open it, or send through a relay with
  [`[smarthost]`](guide.md#smarthost) on 587 or 465.
- **Ports 25, 80, 443, 465, 587 and 993 open inbound** to the host (the
  provider's firewall; see [the firewall](#the-firewall)), and free on
  it, or Traefik in front of some of them ([behind Traefik](#behind-traefik)).

## Choose a variant

The three compose files in [`deploy/`](https://github.com/softistx/bumail/tree/develop/deploy)
each run the same image and differ in who owns the ports:

| file | who owns the ports | pick it when |
| --- | --- | --- |
| `compose.yaml` | bumail, directly: 25, 80, 443, 465, 587 and 993 | the host runs nothing else on them. **The default.** |
| `compose.traefik.yaml` | Traefik owns 80 and 443; bumail publishes 25, 465, 587 and 993 itself | Traefik is on the host and serves other sites, and is free of the mail ports |
| `compose.traefik-tcp.yaml` | Traefik owns all six; the mail ports go through its TCP routers with the PROXY protocol | Traefik already holds 25, 465, 587 or 993 |

In every variant bumail obtains its **own certificate** from the ACME CA
by HTTP-01 (`tls.mode = "acme"`, the default), which serves SMTP's
STARTTLS and implicit TLS, and IMAP. The next section is the standalone
variant; the Traefik ones change steps 2, 3 and 5 only.

## Deploy in 7 steps

### 1. DNS and the PTR

Publish an **A** record (and an **AAAA** one if the host has IPv6) for
the server's name, and have the provider set the PTR of the address to
the same name:

```text
mail.example.com.  IN A  203.0.113.10
```

Check both, from any machine:

```sh
dig +short mail.example.com
dig +short -x 203.0.113.10
```

```text
203.0.113.10
mail.example.com.
```

The other records (MX, SPF, DKIM, DMARC) wait for step 6, when the server
can print them. The A record must be there now: the CA looks up
`mail.example.com` when it validates the certificate.

### 2. Fetch the deploy files and the image

The compose files are in the repository, at the tag of the release you
install: set `VERSION` to it, the newest on the
[releases page](https://github.com/softistx/bumail/releases) (a tag named
`@bumail/server@<version>`). A sparse clone takes only `deploy/`:

```sh
VERSION=0.1.0   # the release you install
git clone --depth 1 --branch "@bumail/server@$VERSION" --filter=blob:none --sparse \
  https://github.com/softistx/bumail
cd bumail
git sparse-checkout set deploy
cd deploy
cp .env.example .env
docker compose pull
```

```text
 bumail Pulling
 bumail Pulled
```

The image is `ghcr.io/softistx/bumail`, for linux/amd64 and linux/arm64,
tagged with each release (`0.1.0`), with its minor (`0.1`, which follows
the patches) and `latest`. The compose files pull `0.1` unless
`BUMAIL_VERSION` in `.env` says otherwise. Nothing is baked in: the image
holds the `bumail` program and no configuration, key or certificate.

**To build the image yourself** instead, from a clone at the same
release tag, add the build override to `.env` and build:

```sh
git clone --branch "@bumail/server@$VERSION" https://github.com/softistx/bumail
cd bumail/deploy
cp .env.example .env
echo 'COMPOSE_FILE=compose.yaml:compose.build.yaml' >> .env   # the later line wins
docker compose build
```

```text
 => [build 4/4] RUN bun install --frozen-lockfile && bun run build && …
 => exporting to image
 => => naming to ghcr.io/softistx/bumail:0.1
```

The build carries the published image's name, so `up` uses it and pulls
nothing; `docker compose pull` and the line removed from `COMPOSE_FILE`
go back to the published one. For a Traefik variant, name its file
instead of `compose.yaml`.

`.env` is read by every `docker compose` command run from `deploy/`.
Set `BUMAIL_HOST` there to your server's name, even in the standalone
variant (only the Traefik files use it).

### 3. Write the configuration

```sh
docker compose run --rm bumail init \
  --hostname mail.example.com --domain example.com \
  --acme-email postmaster@example.com
```

```text
wrote /data/bumail.toml
added the domain example.com
generated an RSA-2048 DKIM key for example.com, selector bumail; mail from example.com is signed with it from now on
publish this TXT record:
  name   bumail._domainkey.example.com
  value  v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…
as a zone file line:
  bumail._domainkey.example.com. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…"

next steps:
  1. add a user:             bumail user add alice@example.com
  2. print the DNS records:  bumail dns --ip <this host's IPv4 address>
     publish them, then:     bumail dns --check
  3. start the server:       bumail serve
```

The steps it prints name `bumail …`: in Docker each one is
`docker compose run --rm bumail …` (steps 4 and 6 below), and the server
is started by step 5.

`init` wrote `bumail.toml`, made the directory of domains and users,
and generated the domain's DKIM key, all on the `/data` volume. It accepts the ACME CA's terms of service on your behalf: read
Let's Encrypt's before you run it. The file is written readable by its owner alone (mode 0600). `init` warns
when a `--trusted-proxy` is not a private or loopback range. The file is short on purpose, and
every key it leaves out has its default ([the guide](guide.md)):

```toml
hostname = "mail.example.com"

[acme]
acceptTerms = true
email = "postmaster@example.com"
```

For a first try that cannot hit Let's Encrypt's rate limits, add
`--acme-staging`: its certificates are not trusted by any client, so run
without it for the real server (`init --force`, below). `init` refuses to
replace a `bumail.toml` that is there, unless `--force` says so; with
`--force` the directory, its domains and its DKIM keys stay as they were.
`bumail check-config` reads the file again and says whether it is valid:

```sh
docker compose run --rm bumail check-config
```

```text
/data/bumail.toml: ok
  hostname      mail.example.com
  …
```

Host more than one domain with a repeated `--domain`. Every flag is in
`docker compose run --rm bumail --help`.

### 4. Add a user

```sh
docker compose run --rm bumail user add alice@example.com
```

```text
New password for alice@example.com:
Again:
added the user alice@example.com, with its mailboxes
```

The password is typed at a hidden prompt, never given on the command
line. In a script, give it on standard input without a terminal:

```sh
printf '%s\n' "$PASSWORD" | docker compose run --rm -T bumail user add alice@example.com --password-stdin
```

A user logs in to submission, IMAP and JMAP with its full address and this
password, over TLS only. Users can be added while the server runs.

### 5. Start the server

```sh
docker compose up -d
docker compose logs -f bumail
```

```text
tls: no certificate stored in /data/acme
tls: waiting for a certificate from https://acme-v02.api.letsencrypt.org/directory
acme: the CA fetched the challenge ayPPYrFl...
tls: obtained (mail.example.com; expires <date>)
bumail: serving mail.example.com
bumail: http listening on 0.0.0.0:80: ACME HTTP-01 challenges on /.well-known/acme-challenge/, a redirect to HTTPS for GET /, 404 for the rest
bumail: health listening on 127.0.0.1:8080: health check, GET /healthz: 200 when every listener is up, a certificate is in use, and the directory and the store answer, else 503
bumail: mx listening on 0.0.0.0:25: SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only
bumail: submissions listening on 0.0.0.0:465: submission over TLS from the first byte: AUTH required, then mail to anywhere
bumail: submission listening on 0.0.0.0:587: submission with STARTTLS: AUTH only after TLS, then mail to anywhere
bumail: imaps listening on 0.0.0.0:993: IMAP over TLS from the first byte
bumail: https listening on 0.0.0.0:443: JMAP over HTTPS: Basic auth for the users of the directory
```

These lines are from a real run of the end-to-end test (its CA, and
`<date>` for what changes), so the names differ from yours.

On a fresh volume the server first asks the CA for a certificate, which
needs port 80 to reach it and the A record of step 1: that takes a few
seconds. When every port is bound the container turns healthy:

```sh
docker compose ps
```

```text
NAME              IMAGE                         COMMAND                  SERVICE   CREATED         STATUS                   PORTS
bumail-bumail-1   ghcr.io/softistx/bumail:0.1   "/usr/local/bin/buma…"   bumail    7 seconds ago   Up 6 seconds (healthy)   0.0.0.0:25->25/tcp, 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:465->465/tcp, 0.0.0.0:587->587/tcp, 0.0.0.0:993->993/tcp
```

`healthy` is what to look for; `starting` lasts until the certificate is
there and every port is bound.

The same check by hand, in the running container (a `run` would start a
new one, where nothing listens):

```sh
docker compose exec bumail bumail health
```

```text
ok
```

It exits 0 for `ok` and 1 for anything else, and prints why. A certificate that does not come, and why, is
[in troubleshooting](troubleshooting.md#tls-and-acme).

### 6. Publish the DNS records and check them

```sh
docker compose run --rm bumail dns --ip 203.0.113.10
```

It prints a zone file of everything the domain needs: the host's A
record, the MX, SPF and DMARC records, the DKIM key, and the SRV records
that let a mail client configure itself. This is its real output from the
end-to-end test (host `standalone.bumail.test`, domain `bumail.test`, a
private address; only the key is cut with `…`):

```text
; DNS records for standalone.bumail.test, and the domains it hosts.
; Publish them at your DNS host, then run bumail dns --check.

; standalone.bumail.test (this server)
standalone.bumail.test. IN A 172.29.77.150
; optional: if the server has a public IPv6 address, bumail dns --ip6 <address> writes its AAAA record
; the reverse DNS (PTR) of 172.29.77.150 should be standalone.bumail.test: it is set at your hosting provider, and many receivers refuse mail without it
; the SRV records carry the ports the server listens on: behind Docker port mapping or a proxy, write the public ports instead

; bumail.test
bumail.test. IN MX 10 standalone.bumail.test.
bumail.test. IN TXT "v=spf1 mx -all"
bumail._domainkey.bumail.test. IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzHIqdtSY7qVNV48o7zmlcyrFaQa2Z4BhVNrH3Lklz…"
_dmarc.bumail.test. IN TXT "v=DMARC1; p=quarantine; adkim=s"
_submissions._tcp.bumail.test. IN SRV 0 1 465 standalone.bumail.test.
_imaps._tcp.bumail.test. IN SRV 0 1 993 standalone.bumail.test.
_jmap._tcp.bumail.test. IN SRV 0 1 443 standalone.bumail.test.
```

Paste them into your DNS host, wait a few minutes, then:

```sh
docker compose run --rm bumail dns --ip 203.0.113.10 --check
```

It looks each record up and exits 0 when every one is there, 1 when one
is missing, differs or is doubled, and 5 when the DNS gave no answer. The
end-to-end test can only run this **partially**: its test DNS
(`pebble-challtestsrv`) holds the host's A record and nothing else, so
this real output shows the statuses, not a finished deployment:

```text
standalone.bumail.test
  ok          A    standalone.bumail.test  172.29.77.150
  missing     PTR  172.29.77.150  standalone.bumail.test
bumail.test
  unavailable MX   bumail.test  10 standalone.bumail.test
                   The DNS could not answer MX bumail.test (ENOTIMP)
  missing     TXT  bumail.test  v=spf1 mx -all
  missing     TXT  bumail._domainkey.bumail.test  v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnisrrBtqSK…
  missing     TXT  _dmarc.bumail.test  v=DMARC1; p=quarantine; adkim=s
  unchecked   SRV  _submissions._tcp.bumail.test  1 465 standalone.bumail.test
  unchecked   SRV  _imaps._tcp.bumail.test  1 993 standalone.bumail.test
  unchecked   SRV  _jmap._tcp.bumail.test  1 443 standalone.bumail.test

4 missing, 1 unavailable: bumail dns prints what to publish
```

On your own DNS, once the records are published, each line reads `ok`
(the SRV lines stay `unchecked`: the DNS client cannot look them up yet).
A `differs` or `missing` PTR is the hosting provider's to fix. See
[the directory](directory.md#bumail-dns) for each record.

### 7. Send a test mail

Submission, with any SMTP client. With [`swaks`](https://jetmore.org/john/code/swaks/):

```sh
swaks --server mail.example.com --port 587 --tls \
  --auth PLAIN --auth-user alice@example.com --auth-password '…' \
  --from alice@example.com --to you@gmail.example
```

```text
<- 250 2.0.0 OK queued as c495b221e62aefdf8d39
```

Watch the queue deliver it, then reply to it from the other account and
read the answer over IMAP on `mail.example.com:993` (the user's full
address, its password), or over JMAP:

```sh
docker compose logs bumail | grep -E 'outbound|mx:'
curl -u alice@example.com https://mail.example.com/.well-known/jmap
```

```text
outbound: c495b221e62aefdf8d39 delivered to you@gmail.example …
mx: 6cbc36297c2aac5b1427 from 198.51.100.7 <you@gmail.example> delivered to alice@example.com (spf=pass dkim=pass dmarc=pass)
```

The other account's "show original" lists `spf=pass`, `dkim=pass` and
`dmarc=pass` for your mail when steps 1 and 6 are right.

**What it never does.** It never relays for strangers (a message for a
domain it does not host is refused unless the session logged in), `AUTH`
is never offered before TLS, and port 25 never offers it at all.

## Behind Traefik

`compose.traefik.yaml` joins the external Docker network Traefik is on.
Traefik ends TLS for JMAP; bumail keeps its own certificate for the mail
ports, and Traefik routes the CA's challenge to it.

What Traefik needs: entry points `web` (80) and `websecure` (443), a
certificate resolver for its own HTTPS (named in `.env` as
`TRAEFIK_CERT_RESOLVER`), and the Docker provider on the network you name
in `TRAEFIK_NETWORK`.

Steps 1 and 2 are the same. In `.env`, set:

```text
COMPOSE_FILE=compose.traefik.yaml
BUMAIL_HOST=mail.example.com
TRAEFIK_NETWORK=proxy
TRAEFIK_CERT_RESOLVER=letsencrypt
```

Step 3 adds the two flags that make JMAP plain HTTP for Traefik, and the
IPv4 subnet of the network Traefik reaches bumail on, which JMAP trusts
and nothing else:

```sh
TRAEFIK_NETWORK=proxy   # the value in .env
SUBNET=$(docker network inspect "$TRAEFIK_NETWORK" \
  --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -m1 '\.')
docker compose run --rm bumail init \
  --hostname mail.example.com --domain example.com \
  --acme-email postmaster@example.com \
  --behind-traefik --trusted-proxy "$SUBNET"
```

The file gains `ports.https = 8081` and a `[jmap]` table:

```toml
[ports]
https = 8081

[jmap]
mode = "proxy"
origin = "https://mail.example.com"
trusted = ["172.18.0.0/16"]
```

Steps 4 to 7 are unchanged, except that JMAP is now answered by
Traefik on 443, on its own certificate. The compose file's labels route
two things to the container:

```yaml
# JMAP: HTTPS from Traefik's own certificate, plain HTTP to bumail's port 8081.
- traefik.http.routers.bumail-jmap.rule=Host(`${BUMAIL_HOST}`)
- traefik.http.routers.bumail-jmap.entrypoints=websecure
# ACME: the challenge path of this host, on port 80, to bumail's port 80.
- traefik.http.routers.bumail-acme.rule=Host(`${BUMAIL_HOST}`) && PathPrefix(`/.well-known/acme-challenge/`)
- traefik.http.routers.bumail-acme.entrypoints=web
- traefik.http.routers.bumail-acme.priority=10000
```

Three things to check on Traefik's side, since each breaks the
challenge and the CA reports a 404 or a timeout (see
[serve.md](serve.md#acme-behind-traefik)):

- **No redirect to HTTPS on the `web` entry point itself**
  (`entryPoints.web.http.redirections`): it is applied before any router.
  Redirect with a middleware on a low-priority router instead.
- **No Traefik certificate resolver using the HTTP challenge** for
  `mail.example.com`: Traefik would answer that path itself. Give its
  resolver the TLS or DNS challenge.
- **The mail ports are bumail's.** This variant publishes 25, 465, 587 and
  993 from the bumail container; if Traefik already holds any of them,
  use the TCP variant below.

The container's health check here is `bumail health --tls-pending`,
because Traefik routes only to a container Docker calls healthy, and a
first start waits for its certificate while the CA must reach port 80
through Traefik: without it the challenge gets a 404 and the first
certificate never comes. The flag accepts one thing only: the health
check's `"tls":"pending"`, the first-start wait with port 80, the
directory and the store answering. `pending` means this process has
served no pair yet, so an expired stored pair, rejected at start, is
`pending` too; `"tls":"down"` (a pair served, then expired) and any other
fault are unhealthy. A first certificate that never comes keeps the
container healthy only during the bounded first-start tries (five, about
four minutes), after which the server exits 5 and Docker restarts it.
With `restart: unless-stopped` and a CA that cannot be reached, it loops
so: see `docker inspect --format '{{.RestartCount}}' <container>`, and the
log lines `tls: the stored certificate is not used: expired` and
`tls: obtaining a certificate failed (try … of …)`.

**Traefik versions.** Tested with Traefik v3.7.13 (the end-to-end test
pins it). The TCP variant's `serversTransport` with `proxyProtocol` needs
**v3.5.2 or later**: that is the first v3 release whose TCP
`serversTransports` reference documents `proxyProtocol` (v3.5.1 and the
v3.0 to v3.4 documentation set it on the service, as
`loadBalancer.proxyProtocol`, and have no such transport option). The
HTTP variant needs only Traefik v3 with the Docker provider.

## Behind Traefik, mail ports included: TCP routers and the PROXY protocol

`compose.traefik-tcp.yaml` adds a Traefik **TCP router** for each of 25,
465, 587 and 993. It passes the bytes through (`HostSNI(*)`, no `tls`
section), so STARTTLS and implicit TLS are bumail's own, and it sends the
**PROXY protocol, version 2**, so bumail still sees the client's real
address for its limits, SPF checks and log. Nothing is published by the
bumail container.

Add to Traefik's **static** configuration the entry points of
[`deploy/traefik/static.yaml`](https://github.com/softistx/bumail/blob/develop/deploy/traefik/static.yaml),
and publish those ports on Traefik's container:

```yaml
entryPoints:
  smtp:
    address: ':25'
  submissions:
    address: ':465'
  submission:
    address: ':587'
  imaps:
    address: ':993'
```

Add to its **dynamic** configuration (the file provider) the
`serversTransport` of
[`deploy/traefik/dynamic.yaml`](https://github.com/softistx/bumail/blob/develop/deploy/traefik/dynamic.yaml),
which the TCP services in the labels name as `bumail-proxy-v2@file`:

```yaml
tcp:
  serversTransports:
    bumail-proxy-v2:
      proxyProtocol:
        version: 2
```

Then step 3 trusts that network for the PROXY protocol as well as for
JMAP, and `.env` takes the third file:

```sh
sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=compose.traefik-tcp.yaml/' .env
docker compose run --rm bumail init \
  --hostname mail.example.com --domain example.com \
  --acme-email postmaster@example.com \
  --behind-traefik --proxy-protocol --trusted-proxy "$SUBNET"
```

```toml
[proxyProtocol]
trusted = ["172.18.0.0/16"]
```

**Trust only Traefik's network.** A peer in `[proxyProtocol] trusted` is
believed when it says who the client is, and must open every connection
with a header or it is reset; any other peer is served as itself. A list
that held the Internet would let anyone pick the address the limiter and
the log see.

To see it work, send a wrong password from another container and read the
log: the line names that container's address, not Traefik's:

```text
submission: login refused from 172.18.0.9: password
mx: f171eda9a882c8560111 from 172.18.0.9 <sender@example.org> delivered to alice@example.com (spf=none dkim=none dmarc=none)
```

The message's `Received` header names the same address.

## Upgrades

Everything the server keeps is on the volume, so an upgrade replaces the
image and nothing else:

```sh
cd bumail/deploy
docker compose pull
docker compose up -d
```

With `BUMAIL_VERSION=0.1` (the default) this takes the newest patch of
that minor. For a new minor or major, read its release notes, set
`BUMAIL_VERSION` in `.env` and fetch the deploy files of that tag too
(`git fetch --depth 1 origin tag '@bumail/server@<version>'`, then
`git checkout` it). If you build the image yourself, `git pull` and
`docker compose build` instead of the pull. Compose recreates the container on the new image: it gets
`SIGTERM`, drains for up to 15 seconds (`stop_grace_period` allows 30),
and starts on the same volume; the certificate on the volume is used at
once, with no call to the CA. Mail that arrives meanwhile is retried by
the sender. A server never downgrades the directory's file: a version
older than the one that last ran it refuses to start. Back up first
([next](#backups)).

## Backups

Everything is in the `bumail_data` volume (the compose project's name,
then `_data`):

| under `/data` | what it holds |
| --- | --- |
| `bumail.toml` | the configuration |
| `directory.sqlite` | domains, users (argon2id hashes), aliases and the **DKIM private keys** |
| `mail/`, `queue/` | the mail store and the outbound queue (with the default `sqlite:` URLs) |
| `acme/` | the CA account's key, the certificate's key and chain |
| `spool/` | messages being checked: temporary, nothing to keep |

SQLite is in WAL mode, and a copy of its files while the server writes
can be torn: back up with the server stopped, which takes seconds.

```sh
docker compose stop bumail
docker run --rm -v bumail_data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/bumail-data-$(date +%F).tgz -C /data .
docker compose start bumail
```

A backup holds password hashes and private keys: keep it as private as the
host. To restore, stop the server and unpack into the volume as root,
which keeps the files' owner (10001):

```sh
docker compose stop bumail
docker run --rm -v bumail_data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* ; tar xzf /backup/bumail-data-<date>.tgz -C /data'
docker compose start bumail
```

With a PostgreSQL or Redis store (`store.url`, `queue.url`), their
contents are backed up with their own tools; the volume still holds the
directory, the DKIM keys and the certificate.

## Logs

The server writes one line per event to standard output, never a
password:

```sh
docker compose logs -f bumail
docker compose logs --since 1h bumail | grep -E 'refused|failed'
```

The compose files keep Docker's own copy at five files of 10 MB. Every
line's form is in [running the server](serve.md#the-log), and the lines
that mean trouble are in [troubleshooting](troubleshooting.md#serving).

## The firewall

| port | who connects | when |
| --- | --- | --- |
| 25 | other mail servers | always: mail for your domains arrives here |
| 80 | the ACME CA, and browsers | always: the CA validates HTTP-01 here, at first and at each renewal |
| 443 | mail clients (JMAP) | when you use JMAP |
| 465, 587 | your users (submission) | always |
| 993 | your users (IMAP) | when you use IMAP |

Outbound, the host must reach other servers' **port 25**, and the CA on
443. Docker publishes a port by its own `iptables` rules, ahead of `ufw`
and `firewalld`: `ufw allow` and `ufw deny` do not govern a published
container port. Restrict by the provider's network firewall, or in the
`DOCKER-USER` chain. The health check (8080) is on loopback inside the
container and published nowhere.

## Secrets

A URL with a password, or the smarthost's password, never goes in
`bumail.toml`: the environment overrides URLs and secrets, each also as
`*_FILE`, which reads the file. In a compose file, a Docker secret is a
file under `/run/secrets`:

```yaml
services:
  bumail:
    environment:
      BUMAIL_SMARTHOST_PASSWORD_FILE: /run/secrets/smarthost_password
      BUMAIL_STORE_URL_FILE: /run/secrets/store_url
    secrets: [smarthost_password, store_url]

secrets:
  smarthost_password:
    file: ./secrets/smarthost_password
  store_url:
    file: ./secrets/store_url
```

The three compose files carry this commented out. The variables are
`BUMAIL_STORE_URL`, `BUMAIL_QUEUE_URL`, `BUMAIL_HOSTNAME` and
`BUMAIL_SMARTHOST_PASSWORD`; see [the guide](guide.md#the-environment).

## What the image holds

- **One program**, `bumail`, compiled from the server and the
  `@bumail/*` packages with Bun's own runtime, on a small glibc base with
  CA certificates and no shell. It reads no `.env` or `bunfig.toml`
  from the directory it runs in.
- **A non-root user**, uid 10001. It binds ports below 1024 because the
  container's network namespace sets `net.ipv4.ip_unprivileged_port_start=0`,
  which Docker does by default and the compose files set explicitly. The
  compose files also drop every capability, forbid new privileges and
  mount the root file system read-only (with `/tmp` in memory): only
  `/data` is written.
- **`VOLUME /data`**, `EXPOSE 25 80 443 465 587 993`,
  `ENTRYPOINT ["bumail"]` and `CMD ["serve", "--config", "/data/bumail.toml"]`,
  so `docker compose run --rm bumail <command>` runs any command of
  `bumail`, and the default is the server.
- **`STOPSIGNAL SIGTERM`** and a **`HEALTHCHECK`** through
  `bumail health`, which asks the server's own loopback `/healthz`: the
  image has no `curl`.
- No shell, so `docker compose exec bumail sh` finds none: run `bumail`
  commands with `docker compose run --rm bumail …`, or
  `docker compose exec bumail bumail …`.

## Checked end to end

`bun run docker:e2e` (from the repository root, with Docker) builds the
image and runs this page against it: its own Traefik v3, Pebble (Let's
Encrypt's test CA, validating HTTP-01 for real) and a test DNS on a
network of their own and high ports. It runs `init`, adds a user,
checks that the certificate is issued through Traefik's challenge route,
that submission on 587 takes STARTTLS and AUTH, that the message is read
back over IMAPS, that JMAP answers through Traefik, that port 25 offers
no AUTH and relays for nobody, that `bumail health` passes, and, for the
TCP variant, that the real client address reaches the log and the
`Received` header through the PROXY protocol. It removes everything it
made.
