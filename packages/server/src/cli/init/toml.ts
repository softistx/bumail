import type { InitArgs } from './args';

/** A TOML basic string. */
const quoted = (text: string) => JSON.stringify(text);
const list = (items: readonly string[]) => `[${items.map(quoted).join(', ')}]`;

/**
 * The starter `bumail.toml` for `args`: the hostname, the ACME terms
 * accepted by the one who ran `init`, and what the variant changes — JMAP
 * as plain HTTP for Traefik, the PROXY protocol from the proxies named.
 * Every other key keeps its default, so the file stays short and says
 * only what this server chose.
 */
export function renderConfig(args: InitArgs): string {
	const lines = [
		'# Written by `bumail init`. Every key not here has its default:',
		'# see the configuration reference for the rest.',
		`hostname = ${quoted(args.hostname)}`,
	];
	if (args.data !== undefined) lines.push(`data = ${quoted(args.data)}`);
	if (args.behindTraefik) {
		lines.push(
			'',
			'# JMAP as plain HTTP for Traefik, which ends TLS for it.',
			'[ports]',
			'https = 8081',
		);
	}
	lines.push(
		'',
		'# The certificate comes from the ACME CA by HTTP-01 on port 80.',
		'[acme]',
		'acceptTerms = true',
	);
	if (args.acmeEmail !== undefined)
		lines.push(`email = ${quoted(args.acmeEmail)}`);
	if (args.acmeStaging) lines.push('directory = "staging"');
	if (args.acmeDirectory !== undefined) {
		lines.push(`directory = ${quoted(args.acmeDirectory)}`);
	}
	if (args.behindTraefik) {
		lines.push(
			'',
			'[jmap]',
			'mode = "proxy"',
			`origin = ${quoted(`https://${args.hostname}`)}`,
			`trusted = ${list(args.trustedProxies)}`,
		);
	}
	if (args.proxyProtocol) {
		lines.push(
			'',
			'# The mail ports read the PROXY protocol, from these peers only.',
			'[proxyProtocol]',
			`trusted = ${list(args.trustedProxies)}`,
		);
	}
	return `${lines.join('\n')}\n`;
}
