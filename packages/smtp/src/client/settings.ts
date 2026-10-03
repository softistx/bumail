import { hostname as machineName } from 'node:os';
import { SmtpError } from '../errors';
import { isHelloName, parsePath } from '../protocol/path';
import { isMailbox } from './address';
import type {
	MxDestination,
	SendMailAuth,
	SendMailEnvelope,
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

/** `INVALID_OPTION`, for an option `sendMail` cannot take. */
export const invalid = (message: string) =>
	new SmtpError('INVALID_OPTION', `sendMail(): ${message}`);

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

/**
 * `from` or a recipient, checked as an RFC 5321 path, since it is written
 * into `MAIL FROM:<…>` or `RCPT TO:<…>` as it is. A source route is refused
 * (§4.1.1.3: clients should not send one), with a message of its own when
 * the route is otherwise valid. What it takes, past the null sender, is
 * exactly what `isMailbox` says yes to: the two share one predicate.
 */
function address(value: unknown, allowNull: boolean): string {
	if (allowNull && value === '') return '';
	if (isMailbox(value)) return value;
	const text = typeof value === 'string' ? value : '';
	const routed = typeof value === 'string' && parsePath(`<${text}>`, false);
	if (routed) {
		throw invalid(
			`${JSON.stringify(value)} holds a source route (@host:), which RFC 5321 says a client should not send: pass ${JSON.stringify(`${routed.local}@${text.slice(text.lastIndexOf('@') + 1)}`)} alone`,
		);
	}
	throw invalid(
		`${JSON.stringify(value)} is not an address (local@domain${allowNull ? ", or '' for a bounce" : ''})`,
	);
}

/**
 * `helo`, checked. By MX it is required: the machine's name (such as
 * `laptop.local`) is rarely a name that resolves back to the sender, which
 * receiving hosts penalise, and it would tell them the machine's name.
 */
function heloOf(value: string | undefined, byMx: boolean): string {
	if (value !== undefined) {
		if (!isHelloName(value))
			throw invalid(`helo "${value}" is not a host name`);
		return value;
	}
	if (byMx)
		throw invalid(
			"helo is required for delivery by MX: pass your server's public name, such as helo: 'mail.example.com'",
		);
	const name = machineName();
	return isHelloName(name) ? name : 'localhost';
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
	if (tls === 'opportunistic' && options.auth && !plaintextAuth)
		throw invalid(
			"auth with tls: 'opportunistic' would send the password to a server whose certificate is not checked; leave tls out to check it, or pass allowPlaintextAuth: true for a local test server",
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
		helo: heloOf(options.helo, byMx(options)),
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

/** Whether the options name a domain to deliver to by MX, not a host. */
export const byMx = (
	options: SendMailOptions,
): options is SendMailEnvelope & MxDestination =>
	!('host' in options && options.host !== undefined);

/** A port: an integer from 1 to 65535. */
export function portOf(port: number | undefined, fallback: number): number {
	if (port === undefined) return fallback;
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw invalid(`port must be an integer from 1 to 65535, not ${port}`);
	return port;
}
