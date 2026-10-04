import type { MailStore } from '@bumail/store';
import type { Credentials } from '../protocol/sasl';

/** What the server knows of one connection; hooks read it, and may keep their own state in `data`. */
export interface ImapSession {
	readonly id: string;
	readonly remoteAddress: string;
	/** TLS is on: implicit, or after STARTTLS. */
	readonly secure: boolean;
	/** The username the client logged in with. */
	readonly user?: string;
	/** The account `authenticate` answered. */
	readonly accountId?: string;
	/** For the app's own state; it lasts the whole connection, STARTTLS included. */
	readonly data: Record<string, unknown>;
}

/** Bun's TLS options: `key` and `cert`, as `Bun.listen` takes them. */
export interface TlsOptions {
	readonly key: string | Uint8Array | Bun.BunFile;
	readonly cert: string | Uint8Array | Bun.BunFile;
}

/** What `authenticate` answers: the account to serve, or `null` (or `undefined`) to refuse. */
export type AuthResult = string | null | undefined;

export interface ImapServerOptions {
	/** The server's own name, in its greeting. */
	readonly hostname: string;
	/** Where the mail is. The server never knows which store it was given. */
	readonly store: MailStore;
	/**
	 * Turns on STARTTLS, or TLS from the first byte with `implicitTls`.
	 * Required: LOGIN and AUTHENTICATE are refused on a clear connection,
	 * so a server without TLS could serve no one.
	 */
	readonly tls: TlsOptions;
	/** TLS from the first byte (port 993, RFC 8314). */
	readonly implicitTls?: boolean;
	/**
	 * Checks credentials, from LOGIN or AUTHENTICATE PLAIN, asked only over
	 * TLS: the id of the account in `store` to serve, or `null` to refuse.
	 * A PLAIN authorization identity other than the username is refused
	 * before this is called.
	 */
	authenticate(
		credentials: Credentials,
		session: ImapSession,
	): AuthResult | Promise<AuthResult>;
	/** Open connections at once. Default 1000. */
	readonly maxConnections?: number;
	/** The largest message APPEND takes, in bytes; announced as APPENDLIMIT (RFC 7889). Default 25 MiB. */
	readonly maxMessageSize?: number;
	/** The largest literal of any other command, in bytes. Default 64 KiB. */
	readonly maxLiteralSize?: number;
	/**
	 * Idle seconds before the server hangs up on a logged-in client; any
	 * byte from the client starts it again. At least 1800, RFC 9051 §5.4's
	 * 30 minutes, and the default.
	 */
	readonly timeout?: number;
	/**
	 * Seconds a client has to log in, from its greeting, however much it
	 * sends. On implicit TLS the greeting waits for the handshake, which
	 * `handshakeTimeout` bounds. Default 60.
	 */
	readonly loginTimeout?: number;
	/**
	 * Seconds a client on implicit TLS has to complete its handshake, from
	 * the TCP connection on; past it, the socket is closed without a word.
	 * The socket holds its slot of `maxConnections` meanwhile. Bun's socket
	 * timer ticks in steps of about 4 s, so the close comes up to that much
	 * later. A STARTTLS handshake is bounded by `loginTimeout`. Default 10.
	 */
	readonly handshakeTimeout?: number;
	/** Seconds between two looks at the store during IDLE. Default 10; more than 0. */
	readonly idleInterval?: number;
	/** Seconds `authenticate` has to settle before the login fails with `NO [UNAVAILABLE]`. Default 60. */
	readonly hookTimeout?: number;
	/**
	 * Told of what went wrong in the app's code or the store: an
	 * `authenticate` that threw or timed out, an account it named that the
	 * store does not have, a store call that failed. The client only sees
	 * `NO [UNAVAILABLE]` or `NO [SERVERBUG]`.
	 */
	onError?(error: unknown, session: ImapSession): void;
}
