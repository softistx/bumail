import { DEFAULT_CONFIG_PATH } from '../config/read';

export const HELP = `Usage: bumail [--config <file>] <command>

The bumail mail server.

Commands:
  serve          check the configuration, then run the server: SMTP from
                 other servers (ports.mx, 25), submission from users
                 (ports.submissions, 465, and ports.submission, 587), the
                 outbound queue, and IMAP over TLS (ports.imaps, 993),
                 until SIGTERM or SIGINT
  check-config   check the configuration, print a summary, and exit
  health         ask the running server's health check (GET /healthz on
                 loopback) and exit 0 when it answers 200, 1 when not: for
                 a container's HEALTHCHECK
       [--tls-pending]        ... also 0 while it waits for a certificate, so
                              Traefik routes the CA's challenge to it
  init           write a starter configuration, make the directory, host
                 the domains and generate their DKIM keys, then print the
                 next steps; it refuses to replace a file unless --force:
       --hostname <name>      the server's own name, the MX host (required)
       --domain <domain>      a domain to host; repeat for more (required)
       [--data <dir>]         where it keeps everything; default /data
       [--acme-email <addr>]  the CA's contact for expiry notices
       [--acme-staging]       Let's Encrypt's staging CA, for a first try
       [--acme-directory <url>]  another ACME CA, a private or test one
       [--behind-traefik]     JMAP as plain HTTP on 8081 for Traefik
       [--proxy-protocol]     the mail ports read the PROXY protocol
       [--trusted-proxy <cidr>]  the proxies' network, for either of those;
                              repeat for more
       [--force]              replace the configuration that is there

  domain add <domain>         host a domain
  domain list                 list the domains, with their users and aliases
  domain remove <domain>      stop hosting a domain with no user or alias left

  user add <address>          add a user, and its mailboxes in the store
  user list [<domain>]        list the users, marking the disabled ones
  user passwd <address>       change a user's password
  user disable <address>      stop a user logging in; its mail is still delivered
  user enable <address>       let a disabled user log in again
  user remove <address>       remove a user, keeping its mail in the store
              [--purge]       ... and delete its mail too

  alias add <address> <user>...  deliver an address to local users
  alias list [<domain>]          list the aliases and their users
  alias remove <address>         remove an alias

  dkim generate <domain>      make an RSA-2048 DKIM key for a domain, and
       [--selector <name>]    print its DNS record; selector default bumail
       [--replace]            ... replacing the key it has
  dkim show <domain>          print a domain's DKIM record again
  dkim list                   list the domains with a key, and its selector
  dkim remove <domain>        remove a domain's key: its mail goes unsigned

Options:
  --config <file>        the TOML configuration; default $BUMAIL_CONFIG,
                         then ${DEFAULT_CONFIG_PATH}
  --password-stdin       user add, user passwd: read the password from
                         standard input
  --password-file <file> user add, user passwd: read it from a file
  -h, --help             print this help
  -v, --version          print the version

A password is never taken from the command line: without those options,
it is typed twice at a prompt.

The environment overrides URLs and secrets only, each also as *_FILE:
  BUMAIL_HOSTNAME, BUMAIL_STORE_URL, BUMAIL_QUEUE_URL,
  BUMAIL_SMARTHOST_PASSWORD

Exit codes: 0 done (serve: stopped cleanly), 1 invalid configuration,
2 bad usage, 3 reserved (nothing returns it now), 4 refused
by the directory (an address, a password, a name taken, not found,
still in use, a selector), 5 the directory, the mail store, the queue,
a port or the certificate (none came from the ACME CA) unavailable.
`;
