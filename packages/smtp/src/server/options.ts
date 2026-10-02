import type { Path } from '../protocol/path';
import type { Reply } from '../protocol/reply';
import type { Credentials } from '../protocol/sasl';

/** What the server knows of one connection; hooks read it, and may keep their own state in `data`. */
export interface Session {
	readonly id: string;
	readonly remoteAddress: string;
	/** TLS is on: implicit, or after STARTTLS. */
	readonly secure: boolean;
	/** The name the client gave in EHLO or HELO. */
	readonly helo?: string;
	/** The client said EHLO, not HELO. */
	readonly esmtp: boolean;
	/** The username the client authenticated as. */
	readonly user?: string;
	/** For the app's own state across hooks. */
	readonly data: Record<string, unknown>;
}

/** The sender and recipients of one message. */
export interface Envelope {
	/** `''` for the null reverse-path `<>`: a bounce. */
	readonly from: string;
	readonly to: readonly string[];
	/** The client asked for SMTPUTF8 (RFC 6531). */
	readonly smtputf8: boolean;
	/** `7BIT` or `8BITMIME`, as MAIL FROM's BODY= said; `7BIT` when it said nothing. */
	readonly body: '7BIT' | '8BITMIME';
}

/** A message received, ready to deliver. */
export interface ReceivedMessage {
	/** The id the server gave it, also in its Received field and the 250 reply. */
	readonly id: string;
	readonly envelope: Envelope;
	/** The message as received, dot-unstuffed, with the server's Received field first. */
	readonly content: Uint8Array;
}

/**
 * What a hook answers: nothing to accept, or a reply — a 4xx or 5xx code —
 * to refuse with. A hook that throws refuses with `451 4.3.0`.
 */
export type HookResult = Reply | undefined | void;

export interface SmtpHooks {
	/** A client connected. */
	onConnect?(session: Session): HookResult | Promise<HookResult>;
	/** After the server's own checks of MAIL FROM. */
	onMailFrom?(path: Path, session: Session): HookResult | Promise<HookResult>;
	/** After the server's own checks of RCPT TO, relaying included. */
	onRcptTo?(path: Path, session: Session): HookResult | Promise<HookResult>;
	/**
	 * The whole message arrived: deliver or queue it before answering. The
	 * reply to DATA waits for this hook, so the client knows whether the
	 * message was taken.
	 */
	onData(
		message: ReceivedMessage,
		session: Session,
	): HookResult | Promise<HookResult>;
}

/** Bun's TLS options: `key` and `cert`, as `Bun.listen` takes them. */
export interface TlsOptions {
	readonly key: string | Uint8Array | Bun.BunFile;
	readonly cert: string | Uint8Array | Bun.BunFile;
}

export interface SmtpServerOptions extends SmtpHooks {
	/** The server's own name, in its greeting, its EHLO reply and its Received fields. */
	readonly hostname: string;
	/**
	 * `mx` receives mail for `localDomains` from anyone, and relays nothing
	 * without AUTH (port 25). `submission` takes mail only from
	 * authenticated users (ports 587 and 465). Default `mx`.
	 */
	readonly mode?: 'mx' | 'submission';
	/**
	 * The domains this server receives mail for. A recipient anywhere else
	 * is relaying, and is refused unless the session authenticated: there is
	 * no option to relay without AUTH.
	 */
	readonly localDomains:
		| readonly string[]
		| ((domain: string) => boolean | Promise<boolean>);
	/** Turns on STARTTLS, or TLS from the first byte with `implicitTls`. */
	readonly tls?: TlsOptions;
	/** TLS from the first byte (port 465, RFC 8314). Needs `tls`. */
	readonly implicitTls?: boolean;
	/**
	 * Checks credentials; turns on AUTH PLAIN and LOGIN (RFC 4954), offered
	 * and accepted only over TLS.
	 */
	authenticate?(
		credentials: Credentials,
		session: Session,
	): boolean | Promise<boolean>;
	/** The largest message, in bytes; announced with SIZE (RFC 1870). Default 25 MiB. */
	readonly maxMessageSize?: number;
	/** Recipients per message. Default 100, the minimum RFC 5321 §4.5.3.1.8 asks a server to take. */
	readonly maxRecipients?: number;
	/** Open connections at once. Default 1000. */
	readonly maxConnections?: number;
	/** Commands that fail before the server hangs up. Default 10. */
	readonly maxErrors?: number;
	/** Idle time before the server hangs up, in seconds. Default 300, RFC 5321 §4.5.3.2.7's. */
	readonly timeout?: number;
}
