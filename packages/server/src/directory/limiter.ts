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

/** The 4 groups of an IPv6 address's /64, expanded and lowercase. */
function prefix64(ip: string): string {
	const [head = '', tail] = ip.toLowerCase().split('::');
	const left = head === '' ? [] : head.split(':');
	const right = tail === undefined || tail === '' ? [] : tail.split(':');
	const groups =
		tail === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	return `${groups
		.slice(0, 4)
		.map((group) => group.replace(/^0+(?=.)/, ''))
		.join(':')}::/64`;
}

/**
 * Who a failure is counted against: an IPv4 address as it is (an
 * IPv4-mapped IPv6 address, `::ffff:192.0.2.1`, as its IPv4), an IPv6
 * address by its /64, which one machine usually holds whole, and
 * anything else — a Unix socket, an empty string — as given.
 */
export function clientKey(ip: string): string {
	const address = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped?.[1] !== undefined) return mapped[1];
	if (isIP(address) === 4) return address;
	// A dotted tail (::ffff:0:192.0.2.1 and the like) is past the /64.
	if (isIP(address) === 6)
		return prefix64(address.replace(/:\d+\.\d+\.\d+\.\d+$/, ':0:0'));
	return ip;
}

/**
 * Failed logins counted per client, in memory, for the listeners to
 * refuse a client that keeps guessing.
 *
 * - A client is blocked once `maxFailures` of its failures fall within
 *   the last `windowSeconds`, and free again as soon as fewer do: a
 *   sliding window, so the oldest failure ageing out frees one try.
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

	/** Whether `ip` is blocked now. */
	blocked(ip: string): boolean {
		return this.#recent(clientKey(ip), this.#now()).length >= this.maxFailures;
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
