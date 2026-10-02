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
	isLocal(domain: string): Promise<boolean>;
}

function positive(
	name: string,
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(
			`createSmtpServer(): ${name} must be a positive integer, not ${value}`,
		);
	}
	return value;
}

export function settingsOf(options: SmtpServerOptions): Settings {
	if (!/^[A-Za-z0-9.-]+$/.test(options.hostname)) {
		throw new TypeError(
			`createSmtpServer(): "${options.hostname}" is not a host name`,
		);
	}
	if (options.implicitTls && !options.tls) {
		throw new TypeError(
			'createSmtpServer(): implicitTls needs tls: { key, cert }',
		);
	}
	if (options.mode === 'submission' && !options.authenticate) {
		throw new TypeError(
			'createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate',
		);
	}
	const local = options.localDomains;
	const domains = Array.isArray(local)
		? new Set(
				(local as readonly string[]).map((domain) => domain.toLowerCase()),
			)
		: undefined;
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
		isLocal: async (domain) =>
			domains
				? domains.has(domain.toLowerCase())
				: (local as (domain: string) => boolean | Promise<boolean>)(
						domain.toLowerCase(),
					),
	};
}
