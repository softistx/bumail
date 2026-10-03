import type { TLSOptions } from 'bun';

/** Where to connect: `host` names the server in errors, and is what TLS checks. */
export interface Endpoint {
	readonly host: string;
	readonly address: string;
	readonly port: number;
}

/** How to start TLS: check the certificate against `servername`, or not. */
export interface TlsTarget {
	readonly servername: string;
	readonly verify: boolean;
	readonly ca?: readonly string[];
}

/** Bun's TLS options for a target: `rejectUnauthorized` only when checking (RFC 7435 otherwise). */
export const tlsOptions = (tls: TlsTarget): TLSOptions => ({
	serverName: tls.servername,
	rejectUnauthorized: tls.verify,
	...(tls.ca ? { ca: [...tls.ca] } : {}),
});

/** Why a connection or a handshake failed, from what Bun gave: its code, else its message. */
export const reason = (error: unknown): string =>
	(error as { code?: string } | null)?.code ??
	(error as Error | null)?.message ??
	'the handshake failed';

/** The whole delivery's deadline. */
export class Clock {
	readonly seconds: number;
	readonly #end: number;

	constructor(seconds: number) {
		this.seconds = seconds;
		this.#end = performance.now() + seconds * 1000;
	}

	/**
	 * `promise`, or what `expire` gives, thrown past `seconds` or the
	 * deadline, whichever comes first; `deadline` says which it was.
	 */
	async race<T>(
		promise: Promise<T>,
		seconds: number,
		expire: (deadline: boolean) => Error,
	): Promise<T> {
		const ms = Math.min(seconds * 1000, this.#end - performance.now());
		const deadline = ms < seconds * 1000;
		if (ms <= 0) throw expire(deadline);
		let timer: Timer | undefined;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(expire(deadline)), ms);
		});
		try {
			return await Promise.race([promise, expired]);
		} finally {
			clearTimeout(timer);
		}
	}
}
