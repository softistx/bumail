import { createSecureContext, type SecureContext } from 'node:tls';

/** `key` or `cert` as `Bun.listen` takes them: text, bytes or a file. */
type TlsMaterial = string | Uint8Array | Bun.BunFile;

/** A key and certificate pair, as `Bun.listen` takes it. */
interface TlsPair {
	readonly key: TlsMaterial;
	readonly cert: TlsMaterial;
}

/** `tls` read whole, with the `node:tls` context made from it. */
interface ReadTls {
	readonly key: string | Buffer;
	readonly cert: string | Buffer;
	readonly context: SecureContext;
}

/**
 * `tls` read whole — a file included — and checked as a `node:tls` context:
 * what implicit TLS behind a proxy runs on, and, without a proxy, the check
 * that makes a key or certificate that cannot be read or used fail
 * `listen()` and `setTls()` the same way. `fail` turns the reason into the
 * package's own error, the `node:tls` or file error as its `cause`.
 */
export async function readTls(
	tls: TlsPair,
	fail: (message: string, cause: unknown) => Error,
	caller: string,
): Promise<ReadTls> {
	const read = async (value: TlsMaterial) =>
		typeof value === 'string'
			? value
			: Buffer.from(value instanceof Uint8Array ? value : await value.bytes());
	try {
		const key = await read(tls.key);
		const cert = await read(tls.cert);
		return { key, cert, context: createSecureContext({ key, cert }) };
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw fail(
			`${caller}: tls: { key, cert } cannot be used: ${reason}`,
			cause,
		);
	}
}

/**
 * The key and certificate the server uses now. What `listen()` or `setTls()`
 * read replaces it whole, and only once checked, so a pair that cannot be
 * used leaves the one in use. A STARTTLS server that has read nothing yet
 * serves `tls` as it was given.
 */
export class TlsHolder {
	#current: ReadTls | undefined;
	readonly #given: TlsPair;

	constructor(given: TlsPair) {
		this.#given = given;
	}

	/** What an upgrade to TLS, or a native listener, is given. */
	get options(): TlsPair {
		return this.#current ?? this.#given;
	}

	/** The `node:tls` context of the pair in use: only once `load` or `replace` read one. */
	get context(): SecureContext {
		if (!this.#current) throw new Error('the TLS pair was never read');
		return this.#current.context;
	}

	/** Reads and checks the pair given, unless a read already replaced it. */
	async load(
		fail: (message: string, cause: unknown) => Error,
		caller: string,
	): Promise<SecureContext> {
		if (this.#current) return this.#current.context;
		const read = await readTls(this.#given, fail, caller);
		this.#current ??= read;
		return this.#current.context;
	}

	/** Checks `tls`, then uses it from the next connection on. */
	async replace(
		tls: TlsPair,
		fail: (message: string, cause: unknown) => Error,
		caller: string,
	): Promise<void> {
		this.#current = await readTls(tls, fail, caller);
	}
}
