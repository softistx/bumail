import { usage, word } from '../verbs';

/** `bumail init`: what to write, and where. */
export interface InitArgs {
	readonly kind: 'init';
	readonly config: string | undefined;
	readonly hostname: string;
	/** `data`, when not the default `/data`. */
	readonly data: string | undefined;
	/** The domains to host, the first one's `postmaster@` the default postmaster. */
	readonly domains: readonly string[];
	readonly acmeEmail: string | undefined;
	readonly acmeStaging: boolean;
	/** Another CA's directory URL, for a private or test CA. */
	readonly acmeDirectory: string | undefined;
	/** JMAP as plain HTTP for Traefik's HTTP router. */
	readonly behindTraefik: boolean;
	/** The PROXY protocol on the mail ports, from `trustedProxies`. */
	readonly proxyProtocol: boolean;
	readonly trustedProxies: readonly string[];
	readonly force: boolean;
}

/** `bumail health`: asks the running server's health check. */
export interface HealthArgs {
	readonly kind: 'health';
	readonly config: string | undefined;
}

/** The options of `init` that take a value, and what they take. */
const VALUES: Readonly<Record<string, string>> = {
	'--config': 'a file',
	'--hostname': 'a host name',
	'--data': 'a directory',
	'--domain': 'a domain',
	'--acme-email': 'an e-mail address',
	'--acme-directory': 'an https: URL',
	'--trusted-proxy': 'an address or a CIDR',
};

/** Whether `arg` is `name` or `name=value`. */
const is = (arg: string, name: string) =>
	arg === name || arg.startsWith(`${name}=`);

/**
 * `init` or `health`, when `argv` has either as its command (the first
 * word, past `--config <file>`); `undefined` for any other command. Each
 * reads its own options and refuses the others.
 */
export function resolveImage(
	argv: readonly string[],
): InitArgs | HealthArgs | undefined {
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (arg === '--config') i++;
		else if (!arg.startsWith('-')) words.push(arg);
		if (words.length > 0) break;
	}
	const command = words[0];
	if (command !== 'init' && command !== 'health') return undefined;
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	let seen = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? '';
		if (!seen && arg === command) {
			seen = true;
			continue;
		}
		if (!arg.startsWith('-')) {
			throw usage(`unexpected argument ${word(arg)}`);
		}
		const name = Object.keys(VALUES).find((key) => is(arg, key));
		if (name !== undefined) {
			const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
			if (value === undefined || value === '') {
				throw usage(`${name} needs ${VALUES[name]}`);
			}
			if (arg === name) i++;
			values.set(name, [...(values.get(name) ?? []), value]);
		} else if (
			[
				'--acme-staging',
				'--behind-traefik',
				'--proxy-protocol',
				'--force',
			].includes(arg)
		) {
			flags.add(arg);
		} else {
			throw usage(`unknown option ${arg.split('=')[0]?.slice(0, 20) ?? ''}`);
		}
	}
	const once = (name: string): string | undefined => {
		const found = values.get(name) ?? [];
		if (found.length > 1) throw usage(`${name} is given twice`);
		return found[0];
	};
	const config = once('--config');
	if (command === 'health') {
		const extra = [...values.keys(), ...flags].filter((n) => n !== '--config');
		if (extra.length > 0) throw usage(`health takes no ${extra[0]}`);
		return { kind: 'health', config };
	}
	const hostname = once('--hostname');
	if (hostname === undefined) throw usage('init needs --hostname');
	const domains = values.get('--domain') ?? [];
	if (domains.length === 0) throw usage('init needs at least one --domain');
	if (flags.has('--acme-staging') && once('--acme-directory') !== undefined) {
		throw usage('--acme-staging and --acme-directory are both given; give one');
	}
	const trustedProxies = values.get('--trusted-proxy') ?? [];
	const behindTraefik = flags.has('--behind-traefik');
	const proxyProtocol = flags.has('--proxy-protocol');
	if (trustedProxies.length > 0 && !behindTraefik && !proxyProtocol) {
		throw usage(
			'--trusted-proxy needs --behind-traefik or --proxy-protocol, which it names the proxies of',
		);
	}
	if ((behindTraefik || proxyProtocol) && trustedProxies.length === 0) {
		throw usage(
			`${behindTraefik ? '--behind-traefik' : '--proxy-protocol'} needs --trusted-proxy: the CIDR of the Docker network Traefik reaches bumail on`,
		);
	}
	return {
		kind: 'init',
		config,
		hostname,
		data: once('--data'),
		domains,
		acmeEmail: once('--acme-email'),
		acmeStaging: flags.has('--acme-staging'),
		acmeDirectory: once('--acme-directory'),
		behindTraefik,
		proxyProtocol,
		trustedProxies,
		force: flags.has('--force'),
	};
}
