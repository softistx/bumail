# bumail demo

A small mail server built from the `@bumail/*` packages, to try them end
to end on one machine, with a real mail client or with the automated
end-to-end script. It is not published, it is not a package, and it is
**not for production**: it uses the self-signed fixture certificate the
package specs use, made for `localhost` and `127.0.0.1` only, and its DNS
is a fixture.

| port | what | how |
| --- | --- | --- |
| 2525 | MX: mail for `@example.test` from anyone | STARTTLS offered; never relays; SPF and DKIM checked, an `Authentication-Results` field added |
| 2587 | submission: mail from alice to anywhere | STARTTLS, then AUTH (offered only after TLS); DKIM-signed for `example.test`; local recipients delivered, others sent to the smarthost |
| 1143 | IMAP | STARTTLS; LOGIN only after TLS |
| 1993 | IMAP | implicit TLS |

Everything binds `127.0.0.1` and serves one `@bumail/store` sqlite store
with one account, `alice@example.test`, which has INBOX, Sent, Drafts,
Archive, Junk and Trash. A delivery calls the IMAP servers' `notify`, so
a client in IDLE sees new mail at once. The smarthost is
[Mailpit](https://mailpit.axllent.org) on `localhost:1025` by default.

The demo uses the packages from this workspace, as built in their `dist/`:
it is a private workspace (`examples/*`), outside the package builds,
`verify:artifacts` and the changesets.

## Run it

From the repository root (Bun 1.4.2, `bun install` done, Docker for
Mailpit):

```sh
docker run -d --rm --name bumail-mailpit -p 8025:8025 -p 1025:1025 axllent/mailpit
DEMO_PASSWORD='choose-one' bun run demo
```

`bun run demo` builds the packages, then starts the demo and prints the
user, the password and the ports; it runs until Ctrl-C. Without
`DEMO_PASSWORD`, a random password is made and printed. Outgoing mail
shows in Mailpit at <http://localhost:8025>. Mailpit is only needed for
mail to other domains: without it, submission to them answers `451`.

The store lives in a fresh temporary directory, removed when the demo
stops. To keep the mail between runs, give it a directory:
`DEMO_DIR=~/bumail-demo-mail bun run demo`.

| variable | default |
| --- | --- |
| `DEMO_PASSWORD` | random, printed |
| `DEMO_DIR` | a new temporary directory, removed on exit |
| `DEMO_BIND` | `127.0.0.1` |
| `DEMO_MX_PORT`, `DEMO_SUBMISSION_PORT` | `2525`, `2587` |
| `DEMO_IMAP_PORT`, `DEMO_IMAPS_PORT` | `1143`, `1993` |
| `SMARTHOST_HOST`, `SMARTHOST_PORT` | `localhost`, `1025` |

## Connect Thunderbird or Apple Mail

The certificate is self-signed for `localhost`: trust it once per port.
That is right for this demo only.

- **Thunderbird**, before adding the account: *Settings → Privacy &
  Security → Manage Certificates… → Servers → Add Exception…*, location
  `localhost:1993`, *Get Certificate*, *Permanently store this
  exception*, *Confirm Security Exception*. Without it, the account
  wizard stops at "The certificate is not trusted because it is
  self-signed". That dialog cannot fetch a certificate over STARTTLS, so
  use `1993` for IMAP; for SMTP on `2587` (and IMAP on `1143`, if you use
  it), Thunderbird asks to accept the certificate at the first connection.
- **Apple Mail**: *Show Certificate*, then trust it for `localhost`, once
  for IMAP and once for SMTP.

| | |
| --- | --- |
| email address | `alice@example.test` |
| username | `alice` (or `alice@example.test`) |
| password | the one the demo printed |
| incoming | IMAP, server `localhost`, port `1993`, **SSL/TLS**, normal password |
| | (or port `1143`, **STARTTLS**) |
| outgoing | SMTP, server `localhost`, port `2587`, **STARTTLS**, normal password, same username |

**Thunderbird**: the app menu → *New Account → Email* (older versions:
*Account Settings → Account Actions → Add Mail Account*). Give the name
and address, then *Configure manually* and the values above:
autodetection will not find `example.test`. If the wizard has no
password field, Thunderbird asks for it at the first *Get Messages*;
tick *Use Password Manager* to keep it.

**Apple Mail**: *Mail → Add Account → Other Mail Account*, then the
address and password; when it cannot verify the account name, enter
`localhost` for both servers, account type IMAP. In the account's
*Server Settings*, turn off *Automatically manage connection settings*:
incoming port `1993` with *Use TLS/SSL* on, outgoing port `2587` with
*Use TLS/SSL* on as well — the server offers AUTH only after STARTTLS.

Then:

- send to `alice@example.test` from the client: it is delivered straight
  to her INBOX, DKIM-signed;
- `RCPT TO:<postmaster>`, with no domain (RFC 5321 §4.5.1), on either
  port, goes to alice, the demo's postmaster (`POSTMASTER` in
  `src/config.ts`);
- send to anyone else: it goes to Mailpit, signed — open
  <http://localhost:8025> and look at its headers;
- send to `alice@example.test` from outside, as another server would, on
  port 2525: it arrives in INBOX, with `Received` and
  `Authentication-Results`, and an IDLE client shows it at once:

```sh
bun -e "import { sendMail } from '@bumail/smtp/client';
await sendMail('From: <bob@sender.test>\r\nTo: <alice@example.test>\r\nSubject: Hi\r\n\r\nHello Alice.\r\n',
  { host: 'localhost', port: 2525, from: 'bob@sender.test', to: 'alice@example.test' })"
```

(Run it from `examples/demo/`, where `@bumail/smtp` resolves.) That one
is not signed, so it gets `dkim=none`; the e2e sends one signed with RFC
8463's published test key for `sender.test`, which the demo's fixture DNS
knows, and gets `dkim=pass`.

Port 2525 relays nothing: mail for any domain but `example.test` is
refused with `554 5.7.1`, whoever sends it.

## The end-to-end script

```sh
bun run demo:e2e
```

It builds the packages, starts Mailpit in Docker unless something already
answers on `localhost:8025` (and stops it afterwards only if it started
it), starts the demo as its own process with a fresh store, and checks
over real sockets (ports below are the defaults):

1. **inbound**: `sendMail` to 2525 for alice, signed for `sender.test`;
   then a raw IMAP session over `node:tls` on 1993 — LOGIN, SELECT INBOX,
   NOOP, SEARCH, FETCH of the ENVELOPE, `BODY[]` and the `Received` and
   `Authentication-Results` fields (`spf=pass`, `dkim=pass`);
2. **IDLE**: a second session in IDLE gets `* n EXISTS` within 2 s of a
   delivery;
3. **submission**: `sendMail` with AUTH on 2587 after STARTTLS, the
   certificate checked, to `someone@elsewhere.test`; the message reaches
   Mailpit (`GET /api/v1/messages`), and its `DKIM-Signature` verifies;
4. **no open relay**: 2525 refuses an outside domain without AUTH (554)
   and an unknown local user (550); on 2587 in clear, EHLO offers no AUTH,
   AUTH is refused (538) and so is MAIL; after STARTTLS, AUTH is offered
   and MAIL is still refused until AUTH; on 1143 in clear, LOGINDISABLED
   and LOGIN refused, then STARTTLS and LOGIN;
5. **IMAP operations**: LIST with SPECIAL-USE, APPEND, STORE `\Seen`,
   SEARCH SEEN and UNSEEN, COPY to Archive, EXPUNGE, MOVE to Archive.

It prints a PASS/FAIL table, stops the demo, and exits 1 if any check
failed, printing what the demo logged. The demo must not already be
running on the same ports: the script needs them. To run it beside a
running demo, give it other ports through the same variables; its check
labels name the ports it used:

```sh
DEMO_MX_PORT=12525 DEMO_SUBMISSION_PORT=12587 \
DEMO_IMAP_PORT=11143 DEMO_IMAPS_PORT=11993 bun run demo:e2e
```

CI typechecks the demo (`bun run typecheck` ends with `typecheck:demo`)
but does not run this script, which needs Docker.

## Files

| file | |
| --- | --- |
| `main.ts` | the entry point: reads the settings, starts the demo, prints how to connect |
| `src/demo.ts` | wires the store, the two SMTP servers and the two IMAP servers |
| `src/inbound.ts` | the MX: SPF at MAIL FROM, DKIM on the message, `Authentication-Results`, delivery |
| `src/submission.ts` | submission: AUTH, DKIM signing, local delivery or the smarthost |
| `src/mailboxes.ts` | alice's account, her login and delivery into INBOX |
| `src/dns.ts` | the fixture DNS: SPF and DKIM records for `example.test` and `sender.test` |
| `src/tls.ts` | the fixture certificate, from `packages/smtp/src/server/fixtures` |
| `e2e.ts` | the end-to-end script: runs the steps in order |
| `e2e/steps/` | one file per step: `inbound`, `idle`, `submission`, `no-relay`, `imap-ops` |
| `e2e/` | what the steps share (`context.ts`), the raw IMAP and SMTP clients, Mailpit, the report |

To type-check it: `bun run typecheck:demo` from the root (or
`bun run --cwd examples/demo typecheck`), after `bun run build`.
