import {
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { configPath, readConfig } from '../../config/read';
import { checkDomain } from '../../directory/address';
import { invalidConfig, ServerError } from '../../errors';
import { manage } from '../manage';
import type { Io } from '../run';
import type { ManageArgs } from '../verbs';
import type { InitArgs } from './args';
import { isPrivateRange } from './private';
import { renderConfig } from './toml';

/** A `domain add` or `dkim generate` of `bumail`, as `init` runs it. */
function step(
	noun: 'domain' | 'dkim',
	verb: 'add' | 'generate',
	domain: string,
): ManageArgs {
	return {
		kind: 'manage',
		noun,
		verb,
		operands: [domain],
		config: undefined,
		password: undefined,
		purge: false,
		selector: undefined,
		replace: false,
	};
}

/**
 * `bumail init`: writes the starter configuration, then makes the
 * directory, adds each domain and generates its DKIM key — the commands
 * `bumail domain add` and `bumail dkim generate`, run for you — and
 * prints what is left to do. It refuses to replace a file that is there,
 * unless `--force` says so, and never leaves one that `readConfig` would
 * refuse: the text is checked in a temporary file beside the target, which
 * only then takes the target's name.
 */
export async function init(args: InitArgs, io: Io): Promise<void> {
	const file = configPath({
		...(args.config === undefined ? {} : { path: args.config }),
		env: io.env,
	});
	const domains = [...new Set(args.domains.map(checkDomain))];
	if (existsSync(file) && !args.force) {
		throw new ServerError(
			'ALREADY_EXISTS',
			`${file} exists; --force replaces it, and keeps the directory and its keys`,
		);
	}
	for (const proxy of args.trustedProxies) {
		if (!isPrivateRange(proxy)) {
			io.err(
				'bumail: warning: --trusted-proxy names a range that is not private or loopback; a trusted proxy is believed about the client address, so list only the network of the proxy, such as the Docker network\n',
			);
			break;
		}
	}
	const dir = dirname(file);
	const temporary = join(dir, `.bumail-init-${crypto.randomUUID()}.toml`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temporary, renderConfig({ ...args, domains }), {
			flag: 'wx',
			mode: 0o600,
		});
		chmodSync(temporary, 0o600);
		const config = await readConfig({ path: temporary, env: io.env }).catch(
			(error: unknown) => {
				// The problems are the text's; the temporary file's name is not.
				throw error instanceof ServerError && error.code === 'INVALID_CONFIG'
					? invalidConfig(file, error.problems)
					: error;
			},
		);
		renameSync(temporary, file);
		io.out(`wrote ${file}\n`);
		const manageIo = { out: io.out, terminal: io.terminal };
		for (const domain of domains) {
			for (const [noun, verb] of [
				['domain', 'add'],
				['dkim', 'generate'],
			] as const) {
				try {
					await manage(step(noun, verb, domain), config, manageIo);
				} catch (error) {
					if (
						!(error instanceof ServerError) ||
						error.code !== 'ALREADY_EXISTS'
					) {
						throw error;
					}
					io.out(`${error.message}; kept\n`);
				}
			}
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	const [first = ''] = domains;
	io.out(
		[
			'',
			'next steps:',
			`  1. add a user:             bumail user add alice@${first}`,
			"  2. print the DNS records:  bumail dns --ip <this host's IPv4 address>",
			'     publish them, then:     bumail dns --check',
			'  3. start the server:       bumail serve',
			'',
		].join('\n'),
	);
}
