import { once, type Tokens } from '../tokens';
import { usage } from '../verbs';

/** `bumail init`: what to write, and where. */
export interface InitArgs {
	readonly kind: 'init';
	readonly config: string | undefined;
	readonly hostname: string;
	/** `data`, when not the default `/data`. */
	readonly data: string | undefined;
	/** The domains to host. */
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

/** The proxies' options: both variants need the network they trust, and it names no default. */
function checkProxies(tokens: Tokens): void {
	const trusted = tokens.values.get('--trusted-proxy') ?? [];
	const traefik = tokens.flags.has('--behind-traefik');
	const proxy = tokens.flags.has('--proxy-protocol');
	if (trusted.length > 0 && !traefik && !proxy) {
		throw usage(
			'--trusted-proxy needs --behind-traefik or --proxy-protocol, which it names the proxies of',
		);
	}
	if ((traefik || proxy) && trusted.length === 0) {
		throw usage(
			`${traefik ? '--behind-traefik' : '--proxy-protocol'} needs --trusted-proxy: the CIDR of the Docker network Traefik reaches bumail on`,
		);
	}
}

/** `init` takes everything but `--tls-pending`; `--hostname` and a `--domain` are required. */
export function resolveInit(tokens: Tokens): InitArgs {
	if (tokens.flags.has('--tls-pending'))
		throw usage('init takes no --tls-pending');
	const hostname = once(tokens, '--hostname');
	if (hostname === undefined) throw usage('init needs --hostname');
	const domains = tokens.values.get('--domain') ?? [];
	if (domains.length === 0) throw usage('init needs at least one --domain');
	const acmeDirectory = once(tokens, '--acme-directory');
	if (tokens.flags.has('--acme-staging') && acmeDirectory !== undefined) {
		throw usage('--acme-staging and --acme-directory are both given; give one');
	}
	checkProxies(tokens);
	return {
		kind: 'init',
		config: once(tokens, '--config'),
		hostname,
		data: once(tokens, '--data'),
		domains,
		acmeEmail: once(tokens, '--acme-email'),
		acmeStaging: tokens.flags.has('--acme-staging'),
		acmeDirectory,
		behindTraefik: tokens.flags.has('--behind-traefik'),
		proxyProtocol: tokens.flags.has('--proxy-protocol'),
		trustedProxies: tokens.values.get('--trusted-proxy') ?? [],
		force: tokens.flags.has('--force'),
	};
}
