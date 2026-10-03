import type {
	MxResolver,
	SendMailAuth,
	SendMailOptions,
	SendMailResult,
	SendMailTimeouts,
	TlsMode,
} from '@bumail/smtp/client';
import type { QueueStore } from '../contract/queue-store';

/** What delivers one message to one destination: `sendMail` of `@bumail/smtp/client`, or a fake in a spec. */
export type Sender = (
	message: Uint8Array,
	options: SendMailOptions,
) => Promise<SendMailResult>;

/** What the queue reads the time from, in milliseconds since the epoch: `Date.now` but in a spec. */
export interface Clock {
	now(): number;
}

/** A host that takes every message for a route: an ISP's relay, a provider's submission port. */
export interface Smarthost {
	readonly host: string;
	/** Default 465 with `secure`, else 25 (587 for submission is yours to give). */
	readonly port?: number;
	/** TLS from the first byte (port 465). */
	readonly secure?: boolean;
	/** Default `required` with `auth` or `secure`, else `opportunistic`. */
	readonly tls?: TlsMode;
	/** Sent only once TLS checked the host's certificate. */
	readonly auth?: SendMailAuth;
	/** Certificates to trust besides the system's, PEM. */
	readonly ca?: string | readonly string[];
}

/** `'mx'`: the recipient domain's own mail hosts, by its MX records. Otherwise, a smarthost. */
export type Route = 'mx' | Smarthost;

/**
 * When to try a deferred recipient again: `first` after the first
 * attempt, then each wait `factor` times the one before, at most `max`,
 * each plus up to `jitter` of itself at random. Past `giveUpAfter` since
 * the message was enqueued, a recipient still deferred fails. Milliseconds.
 */
export interface RetrySchedule {
	/** Default 30 minutes, RFC 5321 §4.5.4.1's least. */
	readonly first?: number;
	/** Default 2. */
	readonly factor?: number;
	/** Default 4 hours. */
	readonly max?: number;
	/** A fraction from 0 to 1. Default 0.1. */
	readonly jitter?: number;
	/** Default 5 days (RFC 5321 §4.5.4.1: "at least 4-5 days"). */
	readonly giveUpAfter?: number;
}

/** The bounds of what the queue takes and keeps. */
export interface QueueLimits {
	/** Bytes. Default 25 MiB. */
	readonly maxMessageSize?: number;
	/** Recipients per message. Default 100 (RFC 5321 §4.5.3.1.8). */
	readonly maxRecipients?: number;
	/** Items the store may hold; `enqueue` refuses past it. Default: no limit. */
	readonly maxItems?: number;
	/** Characters of a reply kept per recipient, from 64 to 900. Default 512. */
	readonly maxReplyText?: number;
	/** Bytes of the original message a DSN returns. Default 64 KiB. */
	readonly maxDsnReturn?: number;
}

/** Delivery status notifications (RFC 3464), sent back to the sender. */
export interface DsnOptions {
	/** The DSN's From address. Default `postmaster@<hostname>`. */
	readonly from?: string;
	/**
	 * Milliseconds after enqueuing before a "delayed" DSN for recipients
	 * still deferred; `false` for none. Default 4 hours.
	 */
	readonly delayAfter?: number | false;
	/**
	 * `headers`: the original's header fields (`text/rfc822-headers`).
	 * `full`: the whole original (`message/rfc822`) when it fits
	 * `maxDsnReturn`, its headers otherwise. Default `headers`.
	 */
	readonly returnContent?: 'headers' | 'full';
}

export interface QueueOptions {
	/** Where items are kept: `MemoryQueueStore`, `SqliteQueueStore`, or your own. */
	readonly store: QueueStore;
	/** This server's public name: given in EHLO, as the DSN's Reporting-MTA, and in the DSN's From. */
	readonly hostname: string;
	/** The default route. Default `'mx'`. */
	readonly route?: Route;
	/** A route per recipient domain, over `route`. */
	readonly routes?: Readonly<Record<string, Route>>;
	/** Needed by the `'mx'` route: `@bumail/dns`'s resolver, or any of its shape. */
	readonly resolver?: MxResolver;
	/** The port of MX hosts. Default 25; another one is for a test. */
	readonly mxPort?: number;
	/** TLS to MX hosts. Default `opportunistic`. */
	readonly mxTls?: TlsMode;
	/** Each step's timeout, in seconds, as `sendMail` takes them. */
	readonly timeouts?: SendMailTimeouts;
	/** Seconds one session may take, DNS included. Default 1800. */
	readonly deadline?: number;
	readonly retry?: RetrySchedule;
	readonly dsn?: DsnOptions;
	readonly limits?: QueueLimits;
	/** Items delivered at once, by this worker. Default 20. */
	readonly concurrency?: number;
	/** Sessions at once to one recipient domain, by this worker. Default 2. */
	readonly perDomain?: number;
	/** How long a claim holds an item, renewed while it is delivered; milliseconds. Default 10 minutes. */
	readonly leaseMs?: number;
	/** How often `start()` looks for due items; milliseconds. Default 5000. */
	readonly pollInterval?: number;
	/** This worker's name on its leases. Default a random UUID. */
	readonly owner?: string;
	/** Default `Date.now`. */
	readonly clock?: Clock;
	/** Default `sendMail` of `@bumail/smtp/client`. */
	readonly send?: Sender;
	/** For the jitter. Default `Math.random`. */
	readonly random?: () => number;
}
