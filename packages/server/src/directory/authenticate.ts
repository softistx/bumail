import { FailureLimiter } from './limiter';
import { byteLength, Gate, hashPassword, MAX_PASSWORD_BYTES } from './password';
import type { UserEntry, Users } from './users';

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
	readonly #users: Users;
	#dummy: Promise<string> | undefined;

	constructor(users: Users, options: AuthenticatorOptions = {}) {
		this.#users = users;
		this.limiter = options.limiter ?? new FailureLimiter();
		this.gate = new Gate(options.maxVerifies, options.maxQueuedVerifies);
	}

	/** A hash of a password nobody knows, made with the users' parameters, verified for an unknown user. */
	#dummyHash(): Promise<string> {
		this.#dummy ??= hashPassword(crypto.randomUUID());
		return this.#dummy;
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
		if (limiter.blocked(ip)) return { ok: false, reason: 'blocked' };
		const refuse = (reason: AuthFailure): AuthResult => {
			limiter.fail(ip);
			return { ok: false, reason };
		};
		if (
			typeof login !== 'string' ||
			typeof password !== 'string' ||
			password === '' ||
			byteLength(login) > MAX_PASSWORD_BYTES ||
			byteLength(password) > MAX_PASSWORD_BYTES
		) {
			return refuse('malformed');
		}
		const user = this.#users.record(login);
		const hash = user?.hash ?? (await this.#dummyHash());
		const verified = await this.gate.run(() =>
			Bun.password.verify(password, hash),
		);
		if (verified === undefined) return { ok: false, reason: 'busy' };
		if (user === undefined) return refuse('unknown');
		if (!verified.value) return refuse('password');
		if (user.disabled) return refuse('disabled');
		const { hash: _, ...entry } = user;
		return { ok: true, user: entry };
	}
}
