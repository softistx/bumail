import { SmtpError } from '../errors';
import type { SmtpServerOptions } from './options';

/** The options with their defaults, checked once. */
export interface Settings {
	readonly options: SmtpServerOptions;
	readonly mode: 'mx' | 'submission';
	readonly maxMessageSize: number;
	readonly maxRecipients: number;
	readonly maxConnections: number;
	readonly maxErrors: number;
	readonly timeout: number;
	readonly hookTimeout: number;
	isLocal(domain: string): boolean | Promise<boolean>;
}

const invalid = (message: string) =>
	new SmtpError('INVALID_OPTION', `createSmtpServer(): ${message}`);

function positive(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw invalid(`${name} must be a positive integer, not ${value}`);
	}
	return value;
}

/** `localDomains` as a lookup; the domain it is given is lower case. */
function localLookup(
	local: SmtpServerOptions['localDomains'],
): (domain: string) => boolean | Promise<boolean> {
	if (typeof local === 'function') return local;
	if (
		Array.isArray(local) &&
		local.every((domain: unknown) => typeof domain === 'string')
	) {
		const domains = new Set(
			(local as readonly string[]).map((domain) => domain.toLowerCase()),
		);
		return (domain) => domains.has(domain);
	}
	throw invalid('localDomains must be an array of domains or a function');
}

export function settingsOf(options: SmtpServerOptions): Settings {
	if (!/^[A-Za-z0-9.-]+$/.test(options.hostname)) {
		throw invalid(`"${options.hostname}" is not a host name`);
	}
	if (typeof options.onData !== 'function') {
		throw invalid('onData must be a function: it is where messages go');
	}
	if (options.implicitTls && !options.tls) {
		throw invalid('implicitTls needs tls: { key, cert }');
	}
	if (options.mode === 'submission' && !options.authenticate) {
		throw invalid(
			'submission takes mail only from authenticated users, so it needs authenticate',
		);
	}
	if (options.authenticate && !options.tls) {
		throw invalid(
			'authenticate needs tls: { key, cert }, since AUTH is offered only once encrypted',
		);
	}
	const isLocal = localLookup(options.localDomains);
	return {
		options,
		mode: options.mode ?? 'mx',
		maxMessageSize: positive(
			'maxMessageSize',
			options.maxMessageSize,
			25 * 1024 * 1024,
		),
		maxRecipients: positive('maxRecipients', options.maxRecipients, 100),
		maxConnections: positive('maxConnections', options.maxConnections, 1000),
		maxErrors: positive('maxErrors', options.maxErrors, 10),
		timeout: positive('timeout', options.timeout, 300),
		hookTimeout: positive('hookTimeout', options.hookTimeout, 60),
		isLocal: (domain) => isLocal(domain.toLowerCase()),
	};
}
