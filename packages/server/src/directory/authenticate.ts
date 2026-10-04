import { ServerError } from '../errors';
import { addressOf } from './address';
import { Gate } from './gate';
import { FailureLimiter } from './limiter';
import {
	byteLength,
	hashPassword,
	MAX_PASSWORD_BYTES,
	normalizePassword,
} from './password';
import type { UserEntry, UserRecord } from './records';

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
 * - `busy`: too many verifies wait already, or the client has as many
 *   logins under way as the limiter lets it; try again later. A
 *   listener answers it as a temporary failure.
 *
 * Every reason but `blocked`, `malformed` and `busy` counts as a failure
 * of the client: each of those cost a verify.
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
	/** How long a verified login is remembered, in seconds; 0 turns the cache off. Default 60. */
	readonly cacheSeconds?: number;
	/**
	 * Told, once, that a login came from a client that is no IP address,
	 * which the limiter cannot count. Default a warning on the console.
	 */
	onUnlimited?(): void;
}

/** The users at a login, with its hash, and the version of one by its address. */
export interface UserLookup {
	find(login: string): UserRecord | undefined;
	version(address: string): number | undefined;
}

/** Logins remembered at most; past it, the oldest is forgotten. */
const MAX_CACHED = 10_000;

interface Cached {
	readonly user: UserEntry;
	readonly version: number;
	readonly expires: number;
}

/**
 * Checks logins against the users, at most a few at a time, counting
 * failures per client.
 *
 * A verified login is remembered for `cacheSeconds`, so a client that
 * authenticates every request (JMAP) costs one verify a minute, not one
 * a request. The cache is keyed by the address and an HMAC of the
 * password under a key this process draws at random, so it holds no
 * password and nothing another process could match. Every hit reads
 * the user's version, which a new password, a disable or an enable
 * bumps, from whichever process: a change counts at the next request.
 * Removing the user ends its hits too.
 */
export class Authenticator {
	readonly limiter: FailureLimiter;
	readonly gate: Gate;
	readonly #users: UserLookup;
	/** A hash of a password nobody knows, made at once with the users' parameters, verified for an unknown login. */
	readonly #dummy: Promise<string>;
	readonly #cacheMs: number;
	readonly #cache = new Map<string, Cached>();
	readonly #hmacKey = crypto.getRandomValues(new Uint8Array(32));
	readonly #onUnlimited: () => void;
	#warned = false;

	constructor(users: UserLookup, options: AuthenticatorOptions = {}) {
		this.#users = users;
		this.limiter = options.limiter ?? new FailureLimiter();
		this.gate = new Gate(options.maxVerifies, options.maxQueuedVerifies);
		const seconds = options.cacheSeconds ?? 60;
		if (!Number.isInteger(seconds) || seconds < 0) {
			throw new ServerError(
				'INVALID',
				'cacheSeconds must be an integer of 0 or more',
			);
		}
		this.#cacheMs = seconds * 1000;
		this.#onUnlimited =
			options.onUnlimited ??
			(() =>
				console.warn(
					'bumail: a login came from a client with no IP address; the failure limiter does not count such logins',
				));
		// Made now, so the first unknown login takes no longer than any other.
		this.#dummy = hashPassword(crypto.randomUUID());
	}

	/** The cache's key for a login: the address, and an HMAC of the password. */
	#cacheKey(address: string, password: string): string {
		const hmac = new Bun.CryptoHasher('sha256', this.#hmacKey)
			.update(normalizePassword(password))
			.digest('base64');
		return `${address}\0${hmac}`;
	}

	/** The user a remembered login answers, if it still holds. */
	#hit(key: string, address: string): UserEntry | undefined {
		const cached = this.#cache.get(key);
		if (cached === undefined) return undefined;
		if (
			cached.expires > Date.now() &&
			this.#users.version(address) === cached.version
		) {
			return cached.user;
		}
		this.#cache.delete(key);
		return undefined;
	}

	#remember(key: string, user: UserEntry, version: number): void {
		if (this.#cacheMs === 0) return;
		this.#cache.delete(key);
		this.#cache.set(key, {
			user,
			version,
			expires: Date.now() + this.#cacheMs,
		});
		if (this.#cache.size > MAX_CACHED) {
			const oldest = this.#cache.keys().next().value;
			if (oldest !== undefined) this.#cache.delete(oldest);
		}
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
		if (!limiter.limits(ip) && !this.#warned) {
			this.#warned = true;
			this.#onUnlimited();
		}
		if (limiter.blocked(ip)) return { ok: false, reason: 'blocked' };
		if (
			typeof login !== 'string' ||
			typeof password !== 'string' ||
			password === '' ||
			byteLength(login) > MAX_PASSWORD_BYTES ||
			byteLength(password) > MAX_PASSWORD_BYTES
		) {
			// No verify and no guess: not counted, so every failure the
			// limiter holds cost one verify, which bounds how many clients
			// can be blocked at once.
			return { ok: false, reason: 'malformed' };
		}
		const address = addressOf(login)?.address;
		const key =
			address === undefined ? undefined : this.#cacheKey(address, password);
		const hit =
			key === undefined || address === undefined
				? undefined
				: this.#hit(key, address);
		if (hit !== undefined) return { ok: true, user: hit };
		const begun = limiter.begin(ip);
		if (begun !== 'started') return { ok: false, reason: begun };
		let failed = true;
		try {
			const result = await this.#verify(login, password, key);
			failed = !result.ok && result.reason !== 'busy';
			return result;
		} finally {
			limiter.end(ip, failed);
		}
	}

	async #verify(
		login: string,
		password: string,
		key: string | undefined,
	): Promise<AuthResult> {
		const user = this.#users.find(login);
		const hash = user?.hash ?? (await this.#dummy);
		const verified = await this.gate.run(() =>
			Bun.password.verify(normalizePassword(password), hash),
		);
		if (verified === undefined) return { ok: false, reason: 'busy' };
		if (user === undefined) return { ok: false, reason: 'unknown' };
		if (!verified.value) return { ok: false, reason: 'password' };
		if (user.disabled) return { ok: false, reason: 'disabled' };
		const { hash: _, version, ...entry } = user;
		if (key !== undefined) this.#remember(key, entry, version);
		return { ok: true, user: entry };
	}
}
