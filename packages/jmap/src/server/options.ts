import type { MailStore } from '@bumail/store';

/**
 * What a client authenticated with: HTTP Basic (RFC 7617), taken only over
 * HTTPS unless `allowInsecureBasic` is set, or a Bearer token (RFC 6750).
 */
export type JmapCredentials =
	| {
			readonly scheme: 'basic';
			readonly username: string;
			readonly password: string;
	  }
	| { readonly scheme: 'bearer'; readonly token: string };

/** What `authenticate` answers: the store account to serve, or `null` (or `undefined`) to refuse. */
export type AuthResult = string | null | undefined;

/** What `onError` is told along with the error. */
export interface ErrorContext {
	readonly request: Request;
	/** The account the request was authenticated as, once it was. */
	readonly accountId?: string;
	/** The method call that failed, for an error inside one. */
	readonly method?: string;
}

/**
 * The limits. Each one in RFC 8620 §2's `urn:ietf:params:jmap:core`
 * capability is announced in the session under the same name.
 */
export interface JmapLimits {
	/** The largest upload, in bytes. Default 25 MiB. */
	readonly maxSizeUpload?: number;
	/** Uploads at once, per account. Default 4. */
	readonly maxConcurrentUpload?: number;
	/** The largest API request body, in bytes. Default 10 MB. */
	readonly maxSizeRequest?: number;
	/** API requests at once, per account. Default 4. */
	readonly maxConcurrentRequests?: number;
	/** Method calls in one request. Default 16. */
	readonly maxCallsInRequest?: number;
	/** Ids in one `/get`. Default 500. */
	readonly maxObjectsInGet?: number;
	/** Creates, updates and destroys in one `/set`. Default 500. */
	readonly maxObjectsInSet?: number;
	/** How deep the request's JSON nests. Default 64. */
	readonly maxJsonDepth?: number;
	/** Values, keys and brackets in the request's JSON. Default 100 000. */
	readonly maxJsonTokens?: number;
	/** Values one back-reference may expand to. Default 5000. */
	readonly maxReferenceItems?: number;
	/**
	 * Bytes of JSON all the back-references of one request may resolve to,
	 * together, whatever the path. Default 4 MiB.
	 */
	readonly maxReferenceBytes?: number;
	/** The largest API response, in bytes of JSON. Default 64 MiB. */
	readonly maxSizeResponse?: number;
	/** Emails a query, a thread lookup or a text search reads at most. Default 10 000. */
	readonly maxQueryScan?: number;
	/** The longest body value returned, in bytes, whatever the client asks. Default 1 MiB. */
	readonly maxBodyValueBytes?: number;
	/** Bytes of body values in one `Email/get` answer. Default 16 MiB. */
	readonly maxBodyValuesTotal?: number;
	/** Bytes of uploads held for one account. Default 100 MiB. */
	readonly uploadQuota?: number;
	/** Seconds an upload is kept. Default 3600; RFC 8620 §6.1 asks for an hour at least. */
	readonly uploadTtl?: number;
}

export interface JmapOptions {
	/** Where the mail is. The server never knows which store it was given. */
	readonly store: MailStore;
	/**
	 * Checks credentials: the id of the account in `store` to serve, or
	 * `null` to refuse. Basic is asked only over HTTPS unless
	 * `allowInsecureBasic` is set; Bearer always.
	 */
	authenticate(
		credentials: JmapCredentials,
		request: Request,
	): AuthResult | Promise<AuthResult>;
	/** The public origin the session's URLs start with: `https://mail.example.com`. */
	readonly origin: string;
	/** Where the API, download and upload routes are. Default `/jmap`. */
	readonly basePath?: string;
	readonly limits?: JmapLimits;
	/** Seconds `authenticate` has to settle. Default 30. */
	readonly hookTimeout?: number;
	/**
	 * Takes Basic credentials on a clear request: for local tests only.
	 * Default `false`: Basic over `http:` is refused unread.
	 */
	readonly allowInsecureBasic?: boolean;
	/**
	 * Whether a request came over TLS. Default: its URL is `https:`. Behind
	 * a proxy that ends TLS, read what the proxy says, such as
	 * `X-Forwarded-Proto`, only when the proxy sets it.
	 */
	secure?(request: Request): boolean;
	/**
	 * Told of what went wrong in the app's code or the store: an
	 * `authenticate` that threw or timed out, an account it named that the
	 * store does not have, a store call that failed. The client only sees
	 * `serverFail`, or a 503.
	 */
	onError?(error: unknown, context: ErrorContext): void;
}
