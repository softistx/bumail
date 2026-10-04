import { createSecureContext, type SecureContext } from 'node:tls';

/** `key` or `cert` as `Bun.listen` takes them: text, bytes or a file. */
type TlsMaterial = string | Uint8Array | Bun.BunFile;

/**
 * `tls` read whole — a file included — and checked as a `node:tls` context:
 * what implicit TLS behind a proxy runs on, and, without a proxy, the check
 * that makes a key or certificate that cannot be read or used fail
 * `listen()` the same way. `fail` turns the reason into the package's own
 * error, the `node:tls` or file error as its `cause`.
 */
export async function tlsContext(
	tls: { readonly key: TlsMaterial; readonly cert: TlsMaterial },
	fail: (message: string, cause: unknown) => Error,
): Promise<SecureContext> {
	const read = async (value: TlsMaterial) =>
		typeof value === 'string'
			? value
			: Buffer.from(value instanceof Uint8Array ? value : await value.bytes());
	try {
		return createSecureContext({
			key: await read(tls.key),
			cert: await read(tls.cert),
		});
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw fail(`listen(): tls: { key, cert } cannot be used: ${reason}`, cause);
	}
}
