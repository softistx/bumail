import type { MailStore } from '@bumail/store';
import { ImapError } from '../errors';
import type { ImapServerOptions } from './options';
import { trustedPeers } from './proxy/trusted';
import { TlsHolder } from './tls-context';

/** The longest delay `setTimeout` takes, in whole seconds: past 2^31 − 1 ms it fires after 1 ms. */
export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

/** RFC 9051 §5.4: an autologout timer after login is 30 minutes at least. */
export const MIN_IDLE_TIMEOUT = 1800;

/** The longest command line taken, in bytes; RFC 9051 §4 asks for 8000 at least. */
export const MAX_LINE = 65_536;

/** Literals in one command before it is refused. */
export const MAX_LITERALS = 32;

/**
 * Before login, only LOGIN takes strings: a user name and a password, each
 * at most 1 KiB as a literal — what LITERAL- (RFC 7888) allows a client
 * that has not logged in. Nobody unknown holds more of the server.
 */
export const MAX_LITERALS_BEFORE_LOGIN = 2;
export const MAX_LITERAL_BEFORE_LOGIN = 1024;

/** The options with their defaults, checked once. */
export interface Settings {
	readonly options: ImapServerOptions;
	readonly store: MailStore;
	readonly maxConnections: number;
	readonly maxMessageSize: number;
	readonly maxLiteralSize: number;
	readonly timeout: number;
	readonly loginTimeout: number;
	readonly handshakeTimeout: number;
	/** The key and certificate in use, which `setTls` replaces. */
	readonly tls: TlsHolder;
	readonly idleInterval: number;
	readonly hookTimeout: number;
	/** With `proxyProtocol`: whether a peer is a proxy trusted to send a PROXY header. */
	readonly trusts?: (peer: string) => boolean;
}

const invalid = (message: string) =>
	new ImapError('INVALID_OPTION', `createImapServer(): ${message}`);

function positive(
	name: string,
	value: number | undefined,
	fallback: number,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw invalid(`${name} must be a positive integer, not ${value}`);
	}
	if (value > max)
		throw invalid(`${name} must be at most ${max}, not ${value}`);
	return value;
}

function timeoutOf(value: number | undefined): number {
	const seconds = positive(
		'timeout',
		value,
		MIN_IDLE_TIMEOUT,
		MAX_TIMER_SECONDS,
	);
	if (seconds < MIN_IDLE_TIMEOUT) {
		throw invalid(
			`timeout must be at least ${MIN_IDLE_TIMEOUT} seconds (RFC 9051 §5.4), not ${seconds}`,
		);
	}
	return seconds;
}

function intervalOf(value: number | undefined): number {
	if (value === undefined) return 10;
	if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_SECONDS) {
		throw invalid(
			`idleInterval must be a number of seconds, more than 0 and at most ${MAX_TIMER_SECONDS}, not ${value}`,
		);
	}
	return value;
}

function checkStore(store: unknown): asserts store is MailStore {
	const methods = [
		'listMailboxes',
		'listMessages',
		'messageChanges',
		'readContent',
	];
	if (
		typeof store !== 'object' ||
		store === null ||
		methods.some(
			(name) => typeof (store as Record<string, unknown>)[name] !== 'function',
		)
	) {
		throw invalid('store must be a MailStore, such as new MemoryMailStore()');
	}
}

export function settingsOf(options: ImapServerOptions): Settings {
	if (
		typeof options.hostname !== 'string' ||
		!/^[A-Za-z0-9.-]+$/.test(options.hostname)
	) {
		throw invalid(`"${options.hostname}" is not a host name`);
	}
	checkStore(options.store);
	if (typeof options.authenticate !== 'function') {
		throw invalid('authenticate must be a function: it is how users log in');
	}
	if (!options.tls?.key || !options.tls.cert) {
		throw invalid(
			'tls: { key, cert } is required, since LOGIN is offered only once encrypted',
		);
	}
	return {
		options,
		tls: new TlsHolder(options.tls),
		store: options.store,
		maxConnections: positive('maxConnections', options.maxConnections, 1000),
		maxMessageSize: positive(
			'maxMessageSize',
			options.maxMessageSize,
			25 * 1024 * 1024,
			0xffffffff,
		),
		maxLiteralSize: positive(
			'maxLiteralSize',
			options.maxLiteralSize,
			64 * 1024,
		),
		timeout: timeoutOf(options.timeout),
		loginTimeout: positive(
			'loginTimeout',
			options.loginTimeout,
			60,
			MAX_TIMER_SECONDS,
		),
		handshakeTimeout: positive(
			'handshakeTimeout',
			options.handshakeTimeout,
			10,
			MAX_TIMER_SECONDS,
		),
		idleInterval: intervalOf(options.idleInterval),
		hookTimeout: positive(
			'hookTimeout',
			options.hookTimeout,
			60,
			MAX_TIMER_SECONDS,
		),
		...(options.proxyProtocol === undefined
			? {}
			: { trusts: trustedPeers(options.proxyProtocol?.trusted, invalid) }),
	};
}
