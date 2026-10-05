# @bumail/server documentation

The [package README](../README.md) is the short version. This folder is the
long one.

| Page | Read it when |
| --- | --- |
| [Guide](guide.md) | writing a configuration: every key, its default, and what the environment overrides |
| [Deploy with Docker](deploy.md) | putting the server on a host: the image, the compose files (standalone, behind Traefik, with TCP routers and the PROXY protocol), `bumail init`, DNS to a test mail in seven steps, upgrades, backups, logs, the firewall |
| [Running the server](serve.md) | running `bumail serve`: the listeners on 25, 465, 587, 993 and 443, what port 25 takes and refuses, SPF, DKIM and DMARC, sending mail, the queue, DKIM signing, IMAP and JMAP logins, running behind Traefik, the health check, the PROXY protocol, the log, stopping |
| [The directory](directory.md) | adding domains, users, aliases and DKIM keys, and the DNS records they need: every `bumail domain`, `user`, `alias`, `dkim` and `dns` command, passwords, logins, the failure limiter |
| [Troubleshooting](troubleshooting.md) | `bumail check-config` (or `readConfig`) reported a problem, a directory command refused something, `bumail init` or `bumail health` refused or failed, the container will not turn healthy or the CA got a 404 behind Traefik, `bumail serve` exited 5, a sender or a mail client got a refusal, the queue logged a failure, or the command exited 2 |
| [Roadmap](roadmap.md) | wondering what the server does next, and what it never will |
