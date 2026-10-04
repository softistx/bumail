import { isIP } from 'node:net';
import { ServerError } from '../errors';

export interface FailureLimiterOptions {
	/** Failed logins from one client within `windowSeconds` before it is blocked. Default 10. */
	readonly maxFailures?: number;
	/** How long a failure counts, in seconds. Default 900 (15 minutes). */
	readonly windowSeconds?: number;
	/** Clients remembered at once; past it, the one whose last failure is oldest is forgotten. Default 100 000. */
	readonly maxClients?: number;
	/** The clock, in milliseconds. Default `Date.now`. */
	readonly now?: () => number;
}

function positive(
	value: number | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) {
		throw new ServerError('INVALID', `${name} must be an integer of 1 or more`);
	}
	return value;
}

/** The 8 groups of an IPv6 address, as numbers; a dotted tail is its last two. */
function groups(ip: string): number[] {
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
	let text = ip;
	if (dotted !== null) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
		];
		text = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = '', tail] = text.split('::');
	const left = head === '' ? [] : head.split(':');
	const right = tail === undefined || tail === '' ? [] : tail.split(':');
	const all =
		tail === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	return all.map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address in the last 32 bits. */
function ipv4Of(g: readonly number[]): string {
	const [high = 0, low = 0] = g.slice(6);
	return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/**
 * Who a failure is counted against: an IPv4 address as it is; an IPv6
 * address that embeds one — IPv4-mapped (`::ffff:192.0.2.1`, in dotted
 * or hex form) or NAT64 (`64:ff9b::/96`) — as that IPv4 address; any
 * other IPv6 address by its /64, which one machine usually holds whole;
 * and anything else — a Unix socket, an empty string — as given.
 */
export function clientKey(ip: string): string {
	const address = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
	if (isIP(address) === 4) return address;
	if (isIP(address) !== 6) return ip;
	const g = groups(address.toLowerCase());
	const prefix = g.slice(0, 6).join(':');
	if (prefix === '0:0:0:0:0:65535' || prefix === '100:65435:0:0:0:0') {
		return ipv4Of(g);
	}
	return `${g
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(':')}::/64`;
}

/**
 * Failed logins counted per client, in memory, for the listeners to
 * refuse a client that keeps guessing.
 *
 * - A client is blocked once `maxFailures` of its failures fall within
 *   the last `windowSeconds`, and free again as soon as fewer do: a
 *   sliding window, so the oldest failure ageing out frees one try.
 * - A login under way counts as a failure until it ends (`begin`,
 *   `end`): logins sent at once get no more guesses than logins sent
 *   in turn. A client may so have at most `maxFailures` logins under
 *   way at once.
 * - While blocked, `authenticate` refuses it without verifying, and does
 *   not count those tries, so trying harder never extends a block: each
 *   failure ageing out gives back one try, and `windowSeconds` after its
 *   last failure a client is forgotten.
 * - A success does not clear the failures: an attacker holding one
 *   account must not wipe the count it guesses others' under.
 * - It lives in memory: a restart forgets it, and each instance counts
 *   its own. At most `maxClients` are remembered, so a spray from many
 *   addresses costs a bounded amount of memory.
 */
export class FailureLimiter {
	readonly maxFailures: number;
	readonly windowMs: number;
	readonly #maxClients: number;
	readonly #now: () => number;
	/** Each client's failures within the window, oldest first, in the order clients last failed. */
	readonly #failures = new Map<string, number[]>();
	/** Each client's logins under way: begun, not yet ended. */
	readonly #pending = new Map<string, number>();

	constructor(options: FailureLimiterOptions = {}) {
		this.maxFailures = positive(options.maxFailures, 10, 'maxFailures');
		this.windowMs =
			positive(options.windowSeconds, 900, 'windowSeconds') * 1000;
		this.#maxClients = positive(options.maxClients, 100_000, 'maxClients');
		this.#now = options.now ?? Date.now;
	}

	/** The failures of `key` still within the window, dropping older ones. */
	#recent(key: string, now: number): number[] {
		const times = this.#failures.get(key);
		if (times === undefined) return [];
		const since = now - this.windowMs;
		while (times.length > 0 && (times[0] ?? 0) <= since) times.shift();
		if (times.length === 0) this.#failures.delete(key);
		return times;
	}

	/** The failures of `key` in the window, and its logins under way. */
	#count(key: string): number {
		return (
			this.#recent(key, this.#now()).length + (this.#pending.get(key) ?? 0)
		);
	}

	/**
	 * Whether `ip` is blocked now: its failures within the window and its
	 * logins under way reach `maxFailures`.
	 */
	blocked(ip: string): boolean {
		return this.#count(clientKey(ip)) >= this.maxFailures;
	}

	/**
	 * Starts a login from `ip`: `false`, starting nothing, when it is
	 * blocked. A login under way counts as a failure until `end`, so a
	 * client sending many at once gets no more verified than one sending
	 * them in turn.
	 */
	begin(ip: string): boolean {
		const key = clientKey(ip);
		if (this.#count(key) >= this.maxFailures) return false;
		this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
		return true;
	}

	/** Ends a login `begin` started, counting it as a failure when `failed`. */
	end(ip: string, failed: boolean): void {
		const key = clientKey(ip);
		const pending = (this.#pending.get(key) ?? 0) - 1;
		if (pending > 0) this.#pending.set(key, pending);
		else this.#pending.delete(key);
		if (failed) this.fail(ip);
	}

	/** Counts a failed login from `ip`. */
	fail(ip: string): void {
		const key = clientKey(ip);
		const now = this.#now();
		const times = this.#recent(key, now);
		times.push(now);
		// Only the last maxFailures matter for a block.
		if (times.length > this.maxFailures) times.shift();
		this.#failures.delete(key);
		this.#failures.set(key, times);
		if (this.#failures.size > this.#maxClients) {
			const oldest = this.#failures.keys().next().value;
			if (oldest !== undefined) this.#failures.delete(oldest);
		}
	}

	/** When `ip` is free again, in milliseconds of the clock; `undefined` when it is not blocked. */
	blockedUntil(ip: string): number | undefined {
		const times = this.#recent(clientKey(ip), this.#now());
		if (times.length < this.maxFailures) return undefined;
		return (times[times.length - this.maxFailures] ?? 0) + this.windowMs;
	}

	/** Clients with a failure still counted. */
	get size(): number {
		return this.#failures.size;
	}
}
