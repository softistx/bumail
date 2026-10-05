import { JmapError } from '../errors';
import type { JmapClient, JmapCredentials } from '../server/options';
import type { Settings } from '../server/settings';
import { cut } from '../shared/text';

/** The account a request was authenticated as. */
export interface Authenticated {
	readonly accountId: string;
	/** The account's login, which the session calls `username`. */
	readonly username: string;
}

/** Why a request was not authenticated, as the client is told. */
export interface Refusal {
	readonly status: 401 | 403 | 503;
	readonly detail: string;
}

export const CHALLENGES = [
	'Basic realm="JMAP", charset="UTF-8"',
	'Bearer realm="JMAP"',
];

/** The longest `Authorization` header read. */
const MAX_AUTHORIZATION = 8192;

const REQUIRED: Refusal = { status: 401, detail: 'Authentication required' };
const FAILED: Refusal = { status: 401, detail: 'Authentication failed' };
const UNAVAILABLE: Refusal = {
	status: 503,
	detail: 'Temporary authentication failure',
};
const CLEAR: Refusal = {
	status: 403,
	detail: 'Basic authentication is refused on a clear connection: use HTTPS',
};

/** The credentials an `Authorization` header holds, or `undefined`. */
export function credentialsOf(
	header: string | null,
): JmapCredentials | undefined {
	if (header === null || header.length > MAX_AUTHORIZATION) return undefined;
	const match = /^(\S+) +(\S+)$/.exec(header.trim());
	if (!match) return undefined;
	const [, scheme = '', value = ''] = match;
	if (scheme.toLowerCase() === 'bearer') {
		return /^[A-Za-z0-9\-._~+/]+=*$/.test(value)
			? { scheme: 'bearer', token: value }
			: undefined;
	}
	if (scheme.toLowerCase() !== 'basic') return undefined;
	let text: string;
	try {
		const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	const colon = text.indexOf(':');
	if (colon < 1) return undefined;
	return {
		scheme: 'basic',
		username: text.slice(0, colon),
		password: text.slice(colon + 1),
	};
}

function isSecure(
	settings: Settings,
	request: Request,
	client: JmapClient,
): boolean {
	const { secure } = settings.options;
	if (secure === undefined) return new URL(request.url).protocol === 'https:';
	try {
		return secure(request, client) === true;
	} catch (error) {
		settings.options.onError?.(error, { request, client });
		return false;
	}
}

/** `authenticate`'s answer, or a `HOOK_TIMEOUT` past `hookTimeout`. */
async function ask(
	settings: Settings,
	credentials: JmapCredentials,
	request: Request,
	client: JmapClient,
): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new JmapError(
						'HOOK_TIMEOUT',
						`authenticate did not settle within hookTimeout (${settings.hookTimeout} s)`,
					),
				),
			settings.hookTimeout * 1000,
		);
	});
	try {
		return await Promise.race([
			Promise.resolve().then(() =>
				settings.options.authenticate(credentials, request, client),
			),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Authenticates a request from `client`: the account it is served as, or why not. */
export async function authenticate(
	settings: Settings,
	request: Request,
	client: JmapClient,
): Promise<Authenticated | Refusal> {
	const credentials = credentialsOf(request.headers.get('authorization'));
	if (credentials === undefined) return REQUIRED;
	if (
		credentials.scheme === 'basic' &&
		settings.options.allowInsecureBasic !== true &&
		!isSecure(settings, request, client)
	) {
		return CLEAR;
	}
	const onError = (error: unknown) =>
		settings.options.onError?.(error, { request, client });
	let answer: unknown;
	try {
		answer = await ask(settings, credentials, request, client);
	} catch (error) {
		onError(error);
		return UNAVAILABLE;
	}
	if (answer === null || answer === undefined) return FAILED;
	if (typeof answer !== 'string' || answer === '') {
		onError(new TypeError('authenticate must answer an account id, or null'));
		return UNAVAILABLE;
	}
	try {
		const account = await settings.store.getAccount(answer);
		if (account !== undefined) {
			return { accountId: account.id, username: account.name };
		}
		onError(
			new Error(
				`authenticate answered the account "${cut(answer)}", which the store does not have`,
			),
		);
	} catch (error) {
		onError(error);
	}
	return UNAVAILABLE;
}
