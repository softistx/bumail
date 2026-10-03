import { hostname as machineName } from 'node:os';
import { SmtpError } from '../errors';
import { parsePath } from '../protocol/path';
import type {
	SendMailAuth,
	SendMailOptions,
	SendMailTimeouts,
	TlsMode,
} from './options';

/** The longest delay `setTimeout` takes, in seconds: past 2^31 − 1 ms it fires after 1 ms. */
export const MAX_SECONDS = Math.floor(2_147_483_647 / 1000);

/** RFC 5321 §4.5.3.2's timeouts; `connect` is this client's own. */
const TIMEOUTS: Required<SendMailTimeouts> = {
	connect: 30,
	greeting: 300,
	command: 300,
	mail: 300,
	rcpt: 300,
	dataStart: 120,
	dataBlock: 180,
	dataEnd: 600,
};

/** The options, checked, with their defaults; timeouts in seconds. */
export interface ClientSettings {
	readonly from: string;
	readonly to: readonly string[];
	readonly helo: string;
	readonly tls: TlsMode;
	readonly secure: boolean;
	readonly ca?: readonly string[];
	readonly auth?: SendMailAuth;
	readonly allowPlaintextAuth: boolean;
	readonly size?: number;
	/** An address is not ASCII, or `smtputf8` asked for it. */
	readonly smtputf8: boolean;
	readonly normalizeLineEnds: boolean;
	readonly timeouts: Required<SendMailTimeouts>;
	readonly deadline: number;
}

const invalid = (message: string) =>
	new SmtpError('INVALID_OPTION', `sendMail(): ${message}`);

const HELO = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.Iv]+\])$/;

function seconds(name: string, value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > MAX_SECONDS
	) {
		throw invalid(
			`${name} must be a number of seconds above 0 and at most ${MAX_SECONDS}, not ${String(value)}`,
		);
	}
	return value;
}

function timeoutsOf(given: SendMailTimeouts = {}): Required<SendMailTimeouts> {
	const out: Record<string, number> = {};
	for (const [name, fallback] of Object.entries(TIMEOUTS)) {
		out[name] = seconds(
			`timeouts.${name}`,
			given[name as keyof SendMailTimeouts],
			fallback,
		);
	}
	return out as Required<SendMailTimeouts>;
}

function address(value: unknown, allowNull: boolean): string {
	const text = typeof value === 'string' ? value : '';
	if (typeof value !== 'string' || !parsePath(`<${text}>`, allowNull)) {
		throw invalid(
			`${JSON.stringify(value)} is not an address (local@domain${allowNull ? ", or '' for a bounce" : ''})`,
		);
	}
	return text;
}

function heloOf(value: string | undefined): string {
	if (value !== undefined) {
		if (!HELO.test(value)) throw invalid(`helo "${value}" is not a host name`);
		return value;
	}
	const name = machineName();
	return HELO.test(name) ? name : 'localhost';
}

function authOf(auth: SendMailAuth | undefined): SendMailAuth | undefined {
	if (auth === undefined) return undefined;
	const { username, password, mechanism } = auth;
	if (typeof username !== 'string' || username === '')
		throw invalid('auth.username must be a non-empty string');
	if (typeof password !== 'string' || password === '')
		throw invalid('auth.password must be a non-empty string');
	if (mechanism !== undefined && mechanism !== 'PLAIN' && mechanism !== 'LOGIN')
		throw invalid(
			`auth.mechanism must be 'PLAIN' or 'LOGIN', not ${mechanism}`,
		);
	return auth;
}

function tlsOf(options: SendMailOptions, plaintextAuth: boolean): TlsMode {
	const secure = options.secure === true;
	const tls =
		options.tls ??
		(secure || (options.auth && !plaintextAuth) ? 'required' : 'opportunistic');
	if (tls !== 'opportunistic' && tls !== 'required' && tls !== 'none')
		throw invalid(
			`tls must be 'opportunistic', 'required' or 'none', not ${tls}`,
		);
	if (tls === 'none' && secure)
		throw invalid(
			"secure is TLS from the first byte: it cannot go with tls: 'none'",
		);
	if (tls === 'none' && options.auth && !plaintextAuth)
		throw invalid(
			"auth with tls: 'none' would send the password in clear; pass allowPlaintextAuth: true for a local test server",
		);
	return tls;
}

/** Checks every option; throws an `SmtpError` (`INVALID_OPTION`) on the first wrong one. */
export function settingsOf(options: SendMailOptions): ClientSettings {
	if (typeof options !== 'object' || options === null)
		throw invalid('options must be an object');
	const from = address(options.from, true);
	const list = typeof options.to === 'string' ? [options.to] : options.to;
	if (!Array.isArray(list) || list.length === 0)
		throw invalid('to must name one recipient or more');
	const to = list.map((recipient) => address(recipient, false));
	const allowPlaintextAuth = options.allowPlaintextAuth === true;
	const { size } = options;
	if (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
		throw invalid(`size must be a number of bytes, not ${size}`);
	const ca = options.ca === undefined ? undefined : [options.ca].flat();
	const auth = authOf(options.auth);
	return {
		from,
		to,
		helo: heloOf(options.helo),
		tls: tlsOf(options, allowPlaintextAuth),
		secure: options.secure === true,
		...(ca ? { ca } : {}),
		...(auth ? { auth } : {}),
		allowPlaintextAuth,
		...(size === undefined ? {} : { size }),
		smtputf8:
			options.smtputf8 === true ||
			[from, ...to].some((text) => /[^ -~]/.test(text)),
		normalizeLineEnds: options.normalizeLineEnds === true,
		timeouts: timeoutsOf(options.timeouts),
		deadline: seconds('deadline', options.deadline, 1800),
	};
}

/** A port: an integer from 1 to 65535. */
export function portOf(port: number | undefined, fallback: number): number {
	if (port === undefined) return fallback;
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw invalid(`port must be an integer from 1 to 65535, not ${port}`);
	return port;
}
