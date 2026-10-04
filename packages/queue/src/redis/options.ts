/**
 * Where a Redis queue keeps its items, and the client it reaches them
 * through.
 *
 * Typed by shape rather than as `Bun.RedisClient`, so the declarations a
 * consumer's `tsc` reads from `@bumail/queue/redis` name no global of
 * Bun's: a `Bun.RedisClient` fits `RedisQueueClient` (`open.spec.ts`
 * checks it, though only because method parameters are compared both
 * ways: Bun declares `args: string[]`; that it writes a `Uint8Array` as
 * its bytes is what the Redis specs show), and so does any client with
 * these methods.
 */

/** A Redis client, such as `new Bun.RedisClient(url)`. */
export interface RedisQueueClient {
	/**
	 * One command; resolves with its reply, a bulk string decoded as
	 * UTF-8. An argument may be bytes (`Bun.RedisClient` sends a
	 * `Uint8Array` as it is), which is how a message is written.
	 */
	send(command: string, args: (string | Uint8Array)[]): Promise<unknown>;
	/** A string value as its bytes, or `null` when there is no such key: how a message is read. */
	getBuffer(key: string): Promise<Uint8Array | null>;
	close(): unknown;
}

interface KeyPrefixOption {
	/**
	 * Put before each key, so several queues, or a queue and the
	 * application, share one Redis database: lowercase letters, digits,
	 * `_`, `:`, `.` and `-`, starting with a letter, at most 40. Default
	 * `bumail:queue:`.
	 */
	readonly keyPrefix?: string;
}

/** The application's client, which it configures and closes itself. */
export interface RedisQueueClientOptions extends KeyPrefixOption {
	readonly client: RedisQueueClient;
	readonly url?: undefined;
}

/** A `redis://` (or `rediss://`, …) URL, for which the store opens a client of its own, closed by `close()`. */
export interface RedisQueueUrlOptions extends KeyPrefixOption {
	readonly url: string | URL;
	readonly client?: undefined;
}

/** `client` or `url`, never both. */
export type RedisQueueStoreOptions =
	| RedisQueueClientOptions
	| RedisQueueUrlOptions;
