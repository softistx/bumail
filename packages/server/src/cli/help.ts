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

  dns [<domain>]              print the DNS records every hosted domain (or
      [--ip <address>]        one) needs: MX, SPF, DKIM, DMARC and the
      [--ip6 <address>]       autoconfig SRV records, as a zone file; --ip and
      [--json]                --ip6 add the host name's A and AAAA records
      [--check]               --check looks them up in the DNS instead, and
                              exits 1 when one is missing or differs, 5
                              when the DNS gave no answer

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

Exit codes: 0 done (serve: stopped cleanly), 1 invalid configuration (dns
--check: a record missing, different or doubled),
2 bad usage, 3 reserved (nothing returns it now), 4 refused
by the directory (an address, a password, a name taken, not found,
still in use, a selector), 5 the directory, the mail store, the queue,
a port or the certificate (none came from the ACME CA) unavailable (dns
--check: the DNS gave no answer).
`;
