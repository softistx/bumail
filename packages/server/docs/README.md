# @bumail/server documentation

The [package README](../README.md) is the short version. This folder is the
long one.

| Page | Read it when |
| --- | --- |
| [Guide](guide.md) | writing a configuration: every key, its default, and what the environment overrides |
| [Running the server](serve.md) | running `bumail serve`: the listeners on 25 and 993, what port 25 takes and refuses, SPF, DKIM and DMARC, IMAP logins, the log, stopping |
| [The directory](directory.md) | adding domains, users and aliases: every `bumail domain`, `user` and `alias` command, passwords, logins, the failure limiter |
| [Troubleshooting](troubleshooting.md) | `bumail check-config` (or `readConfig`) reported a problem, a directory command refused something, `bumail serve` exited 3 or 5, a sender got a refusal, or the command exited 2 |
| [Roadmap](roadmap.md) | wondering what the server does next, and what it never will |
