import { DEFAULT_CONFIG_PATH } from '../config/read';

export const HELP = `Usage: bumail [--config <file>] <command>

The bumail mail server.

Commands:
  serve          check the configuration, then run the server
                 (not implemented yet: it checks, and exits 3)
  check-config   check the configuration, print a summary, and exit

Options:
  --config <file>  the TOML configuration; default $BUMAIL_CONFIG,
                   then ${DEFAULT_CONFIG_PATH}
  -h, --help       print this help
  -v, --version    print the version

The environment overrides URLs and secrets only, each also as *_FILE:
  BUMAIL_HOSTNAME, BUMAIL_STORE_URL, BUMAIL_QUEUE_URL,
  BUMAIL_SMARTHOST_PASSWORD

Exit codes: 0 done, 1 invalid configuration, 2 bad usage,
3 not implemented yet.
`;
