import { Gate } from './gate';
import { FailureLimiter } from './limiter';
import {
	byteLength,
	hashPassword,
	MAX_PASSWORD_BYTES,
	normalizePassword,
} from './password';
import type { UserEntry, UserRecord } from './users';

/**
 * Why a login was refused, for the server's log; a client is told only
 * that it failed.
 *
 * - `blocked`: the client failed too often lately (`FailureLimiter`);
 *   nothing was verified.
 * - `malformed`: an empty password, or a login or a password over 1024
 *   bytes; nothing was verified.
 * - `unknown`: no user has that address; a dummy hash was verified, so
 *   this takes as long as a wrong password.
 * - `password`: the password is wrong.
 * - `disabled`: the password is right, but the user is disabled.
 * - `busy`: too many verifies wait already; try again later. A listener
 *   answers it as a temporary failure.
 *
 * Every reason but `blocked` and `busy` counts as a failure of the client.
 */
export type AuthFailure =
	| 'blocked'
	| 'malformed'
	| 'unknown'
	| 'password'
	| 'disabled'
	| 'busy';

/** What `authenticate` answers. */
export type AuthResult =
	| { readonly ok: true; readonly user: UserEntry }
	| { readonly ok: false; readonly reason: AuthFailure };

export interface AuthenticatorOptions {
	/** Verifies at once. Default 4. */
	readonly maxVerifies?: number;
	/** Verifies waiting for a place; past it, `busy`. Default 1000. */
	readonly maxQueuedVerifies?: number;
	/** Counts failures per client. Default a `FailureLimiter` with its defaults. */
	readonly limiter?: FailureLimiter;
}

/** Checks logins against the users, at most a few at a time, counting failures per client. */
export class Authenticator {
	readonly limiter: FailureLimiter;
	readonly gate: Gate;
	/** The user at a login, with its hash. */
	readonly #find: (login: string) => UserRecord | undefined;
	/** A hash of a password nobody knows, made at once with the users' parameters, verified for an unknown login. */
	readonly #dummy: Promise<string>;

	constructor(
		find: (login: string) => UserRecord | undefined,
		options: AuthenticatorOptions = {},
	) {
		this.#find = find;
		this.limiter = options.limiter ?? new FailureLimiter();
		this.gate = new Gate(options.maxVerifies, options.maxQueuedVerifies);
		// Made now, so the first unknown login takes no longer than any other.
		this.#dummy = hashPassword(crypto.randomUUID());
	}

	/**
	 * Checks `password` for the user `login` (any spelling of its
	 * address), from the client at `ip`.
	 */
	async authenticate(
		login: string,
		password: string,
		ip: string,
	): Promise<AuthResult> {
		const { limiter } = this;
		if (!limiter.begin(ip)) return { ok: false, reason: 'blocked' };
		let failed = true;
		try {
			const result = await this.#check(login, password);
			failed = !result.ok && result.reason !== 'busy';
			return result;
		} finally {
			limiter.end(ip, failed);
		}
	}

	async #check(login: string, password: string): Promise<AuthResult> {
		if (
			typeof login !== 'string' ||
			typeof password !== 'string' ||
			password === '' ||
			byteLength(login) > MAX_PASSWORD_BYTES ||
			byteLength(password) > MAX_PASSWORD_BYTES
		) {
			return { ok: false, reason: 'malformed' };
		}
		const user = this.#find(login);
		const hash = user?.hash ?? (await this.#dummy);
		const verified = await this.gate.run(() =>
			Bun.password.verify(normalizePassword(password), hash),
		);
		if (verified === undefined) return { ok: false, reason: 'busy' };
		if (user === undefined) return { ok: false, reason: 'unknown' };
		if (!verified.value) return { ok: false, reason: 'password' };
		if (user.disabled) return { ok: false, reason: 'disabled' };
		const { hash: _, ...entry } = user;
		return { ok: true, user: entry };
	}
}
