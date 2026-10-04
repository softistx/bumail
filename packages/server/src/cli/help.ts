import { DEFAULT_CONFIG_PATH } from '../config/read';

export const HELP = `Usage: bumail [--config <file>] <command>

The bumail mail server.

Commands:
  serve          check the configuration, then run the server
                 (not implemented yet: it checks, and exits 3)
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

Exit codes: 0 done, 1 invalid configuration, 2 bad usage,
3 not implemented yet, 4 refused by the directory (an address, a
password, a name taken, not found, still in use), 5 the directory or
the mail store unavailable.
`;
