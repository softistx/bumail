/**
 * The directory's `authenticate`, in the shapes the listeners take: the
 * `authenticate` option of `@bumail/smtp`, `@bumail/imap` and
 * `@bumail/jmap`. Each is typed by the shape it is given, so nothing of
 * those packages is imported; `adapters.spec.ts` asserts each fits.
 */
import type { MailStore } from '@bumail/store';
import { ServerError } from '../errors';
import { provisionAccount } from '../store/accounts';
import type { AuthFailure, AuthResult } from './authenticate';

/** What checks a login: a `Directory`. */
export interface Authenticates {
	authenticate(
		login: string,
		password: string,
		ip: string,
	): Promise<AuthResult>;
}

/** The credentials SMTP's AUTH and IMAP's LOGIN give. */
export interface LoginCredentials {
	readonly username: string;
	readonly password: string;
}

/** The session SMTP and IMAP give along: who is connected. */
export interface ClientSession {
	readonly remoteAddress: string;
}

/** What JMAP's `authenticate` is given: Basic, or a Bearer token, which v1 refuses. */
export type JmapLogin =
	| {
			readonly scheme: 'basic';
			readonly username: string;
			readonly password: string;
	  }
	| { readonly scheme: 'bearer'; readonly token: string };

export interface AdapterOptions {
	/** Told of each refusal, for the server's log: why, and from where. Never the password. */
	onRefused?(reason: AuthFailure, ip: string): void;
}

/** What `busy` throws: each listener answers it as a temporary failure (454, `NO [UNAVAILABLE]`, 503). */
export const BUSY_MESSAGE = 'too many logins under way; try again later';

/**
 * `directory.authenticate`, the refusal told to `onRefused`: the result
 * of a login that went through, `undefined` for one refused; `busy`
 * throws `UNAVAILABLE` (`BUSY_MESSAGE`). For a listener that keeps what
 * the login answered, such as submission its user's version.
 */
export async function checkLogin(
	directory: Authenticates,
	login: string,
	password: string,
	ip: string,
	options: AdapterOptions,
): Promise<(AuthResult & { readonly ok: true }) | undefined> {
	const result = await directory.authenticate(login, password, ip);
	if (result.ok) return result;
	options.onRefused?.(result.reason, ip);
	if (result.reason === 'busy')
		throw new ServerError('UNAVAILABLE', BUSY_MESSAGE);
	return undefined;
}

/** `@bumail/smtp`'s `authenticate`: `true` for a user's right password. */
export function smtpAuthenticate(
	directory: Authenticates,
	options: AdapterOptions = {},
): (credentials: LoginCredentials, session: ClientSession) => Promise<boolean> {
	return async ({ username, password }, { remoteAddress }) =>
		(await checkLogin(
			directory,
			username,
			password,
			remoteAddress,
			options,
		)) !== undefined;
}

/**
 * `@bumail/imap`'s `authenticate`: the id of the user's account in
 * `store`, created with its mailboxes on its first login if the `bumail`
 * command could not create it, or `null`.
 */
export function imapAuthenticate(
	directory: Authenticates,
	store: MailStore,
	options: AdapterOptions = {},
): (
	credentials: LoginCredentials,
	session: ClientSession,
) => Promise<string | null> {
	return async ({ username, password }, { remoteAddress }) => {
		const result = await checkLogin(
			directory,
			username,
			password,
			remoteAddress,
			options,
		);
		if (result === undefined) return null;
		return (await provisionAccount(store, result.user.address)).id;
	};
}

/**
 * `@bumail/jmap`'s `authenticate`: as `imapAuthenticate`, for Basic
 * credentials; a Bearer token is refused, there being none in v1. The
 * client's address comes from `ipOf`, as the HTTP server knows it
 * (`server.requestIP(request)`).
 */
export function jmapAuthenticate(
	directory: Authenticates,
	store: MailStore,
	ipOf: (request: Request) => string,
	options: AdapterOptions = {},
): (credentials: JmapLogin, request: Request) => Promise<string | null> {
	return async (credentials, request) => {
		if (credentials.scheme !== 'basic') return null;
		const ip = ipOf(request);
		const result = await checkLogin(
			directory,
			credentials.username,
			credentials.password,
			ip,
			options,
		);
		if (result === undefined) return null;
		return (await provisionAccount(store, result.user.address)).id;
	};
}
