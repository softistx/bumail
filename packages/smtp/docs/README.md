# @bumail/smtp documentation

The [package README](../README.md) is the short version. This folder is the
long one.

| Page | Read it when |
| --- | --- |
| [Guide](guide.md) | running an MX, a submission server or implicit TLS; reading what a reply means; writing hooks and keeping state in `Session.data`; handling what `onData` receives; delivering into `@bumail/store`; setting TLS, limits and `greetingDelay`; sending mail with `@bumail/smtp/client` and trying it with Mailpit; or checking which RFC a behaviour follows |
| [Troubleshooting](troubleshooting.md) | `createSmtpServer` threw, the server will not listen, a client reports a reply you did not expect, or `sendMail` rejected |
| [Roadmap](roadmap.md) | wondering what is coming — connection reuse in the client, DSN, a ready-made delivery into the store — and what is not planned |
