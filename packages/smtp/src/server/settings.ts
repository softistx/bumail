import { SmtpError } from '../errors';
import type { SmtpServerOptions } from './options';
import { trustedPeers } from './proxy/trusted';

/** The options with their defaults, checked once. */
export interface Settings {
	readonly options: SmtpServerOptions;
	readonly mode: 'mx' | 'submission';
	readonly maxMessageSize: number;
	readonly maxRecipients: number;
	readonly maxConnections: number;
	readonly maxConnectionsPerClient: number;
	readonly maxErrors: number;
	readonly timeout: number;
	readonly hookTimeout: number;
	readonly handshakeTimeout: number;
	readonly greetingDelay: number;
	/** With `proxyProtocol`: whether a peer is a proxy trusted to send a PROXY header. */
	readonly trusts?: (peer: string) => boolean;
	isLocal(domain: string): boolean | Promise<boolean>;
}

/** The longest delay `setTimeout` takes, in whole seconds: past 2^31 − 1 ms it fires after 1 ms. */
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

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

/** `positive`, and short enough for `setTimeout`, which a longer delay makes fire at once. */
function timer(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	const seconds = positive(name, value, fallback);
	if (seconds > MAX_TIMER_SECONDS) {
		throw invalid(
			`${name} must be at most ${MAX_TIMER_SECONDS} seconds, not ${seconds}`,
		);
	}
	return seconds;
}

function nonNegative(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) {
		throw invalid(
			`${name} must be a number of seconds, 0 or more, not ${value}`,
		);
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
	if (
		typeof options.hostname !== 'string' ||
		!/^[A-Za-z0-9.-]+$/.test(options.hostname)
	) {
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
	const timeout = positive('timeout', options.timeout, 300);
	const greetingDelay = nonNegative('greetingDelay', options.greetingDelay, 0);
	if (greetingDelay >= timeout) {
		throw invalid(
			`greetingDelay (${greetingDelay} s) must be shorter than timeout (${timeout} s), or every client times out before the greeting`,
		);
	}
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
		maxConnectionsPerClient: positive(
			'maxConnectionsPerClient',
			options.maxConnectionsPerClient,
			10,
		),
		maxErrors: positive('maxErrors', options.maxErrors, 10),
		timeout,
		hookTimeout: timer('hookTimeout', options.hookTimeout, 60),
		handshakeTimeout: positive(
			'handshakeTimeout',
			options.handshakeTimeout,
			10,
		),
		greetingDelay,
		...(options.proxyProtocol === undefined
			? {}
			: { trusts: trustedPeers(options.proxyProtocol?.trusted, invalid) }),
		isLocal: (domain) => isLocal(domain.toLowerCase()),
	};
}
