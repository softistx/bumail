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
	/**
	 * For the app's own state across hooks. It lasts the whole connection,
	 * STARTTLS included: what the server learnt before TLS is forgotten, but
	 * what the app keeps here is the app's to judge.
	 */
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

/** A message on its way in, handed to `onData` as the client sends it. */
export interface ReceivedMessage {
	/** The id the server gave it, also in its Received field and the 250 reply. */
	readonly id: string;
	readonly envelope: Envelope;
	/**
	 * The message as the client sends it, dot-unstuffed, with the server's
	 * Received field first. It holds 64 KiB at most: the server reads the
	 * client only as fast as this stream is read.
	 *
	 * It ends in an `SmtpError` when the message must not be delivered:
	 * `MESSAGE_TOO_BIG`, `BARE_LINE_BREAK` (SMTP smuggling),
	 * `CONNECTION_LOST`, `HOOK_TIMEOUT` or `MESSAGE_NOT_READ`. Read it to
	 * its end before keeping anything: a message is taken only when the
	 * stream ended cleanly and `onData` resolved, within `hookTimeout`,
	 * without a refusal. `signal` says when it was not.
	 */
	readonly content: ReadableStream<Uint8Array>;
	/**
	 * Aborts when the server refuses the message on `onData`'s behalf: the
	 * stream errored, `onData` accepted before reading to the end, did not
	 * answer within `hookTimeout`, threw, or answered what is not a
	 * refusal, or the connection closed before the reply. Its `reason` is
	 * the `SmtpError`, or what `onData` threw. A refusal `onData` returns
	 * itself leaves it alone, read or not. The stream may already have
	 * ended cleanly, so check `signal.aborted` (or listen for `abort`)
	 * before keeping a message for good: the client will send it again.
	 */
	readonly signal: AbortSignal;
}

/**
 * What a hook answers: nothing to accept, or a reply — a 4xx or 5xx code —
 * to refuse with. A hook that throws, answers anything else, or does not
 * settle within `hookTimeout` refuses with `451 4.3.0`, and the error goes
 * to `onError`.
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
	 * A message is coming: read `message.content` to its end, then deliver
	 * or queue it before resolving. The reply to DATA waits for this hook
	 * and for the end of the content, so the client knows whether the
	 * message was taken. If the stream errors, do not deliver.
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
	 * The domains this server receives mail for, matched whole and without
	 * case. A recipient anywhere else is relaying, and is refused unless the
	 * session authenticated: there is no option to relay without AUTH. A
	 * function is given the domain in lower case; if it throws or times out,
	 * that recipient gets `451 4.3.0`.
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
	 * and accepted only over TLS, so it needs `tls`. Only `true` accepts. A
	 * PLAIN authorization identity other than the username is refused before
	 * this is called: a session acts as the user it authenticated as.
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
	/** Idle time before the server hangs up, in seconds; any byte from the client starts it again. Default 300, RFC 5321 §4.5.3.2.7's. */
	readonly timeout?: number;
	/**
	 * Seconds the server waits, once `onConnect` accepted, before its 220
	 * greeting. A client that talks in that time is refused with `554`
	 * (RFC 5321 §4.3.1): a legitimate client waits for the greeting, many
	 * spam senders do not. Default 0: the greeting goes out at once, and
	 * only a client that talks before it is refused.
	 */
	readonly greetingDelay?: number;
	/**
	 * Seconds a hook, `authenticate` or `localDomains` has to settle — and
	 * `onData` to read the next part of a message, then to answer once it
	 * ended. Past it, the command is refused with `451 4.3.0`. Default 60.
	 */
	readonly hookTimeout?: number;
	/**
	 * Told of what went wrong in the app's code: a hook, `authenticate` or
	 * `localDomains` that threw or timed out, or a hook reply that is not a
	 * refusal. The client only sees a 451 or 454.
	 */
	onError?(error: unknown, session: Session): void;
}
