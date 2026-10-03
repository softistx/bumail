import type { RecipientReply } from '../errors';
import type { Reply } from '../protocol/reply';

/** A message as `sendMail` takes it: the whole RFC 5322 text, headers first, lines ending in CRLF. */
export type MessageSource = Uint8Array | string | ReadableStream<Uint8Array>;

/**
 * `opportunistic`: STARTTLS when offered, the certificate not checked
 * (RFC 7435); clear otherwise. `required`: TLS, the certificate checked
 * against the host name, or no delivery. `none`: never TLS.
 */
export type TlsMode = 'opportunistic' | 'required' | 'none';

/**
 * What MX delivery asks of the DNS, by shape: the `Resolver` of bumail's
 * DNS package answers it, and so does any object with these three
 * methods. Declared here rather than imported, so these declarations
 * compile without that package installed.
 */
export interface MxResolver {
	/** The MX records of a domain; `exchange` `''` for a null MX (RFC 7505). */
	mx(
		name: string,
	): Promise<
		readonly { readonly exchange: string; readonly priority: number }[]
	>;
	/** The IPv4 addresses of a name. */
	a(name: string): Promise<readonly { readonly address: string }[]>;
	/** The IPv6 addresses of a name. */
	aaaa(name: string): Promise<readonly { readonly address: string }[]>;
}

/** A host to hand the message to: a smarthost, a submission server, a local Mailpit. */
export interface HostDestination {
	/** A host name or an address; the name TLS checks the certificate against. */
	readonly host: string;
	/** Default 465 with `secure`, else 25. */
	readonly port?: number;
}

/** Direct delivery to a domain's mail hosts, by its MX records (RFC 5321 §5.1). */
export interface MxDestination {
	readonly domain: string;
	readonly resolver: MxResolver;
	/**
	 * The name this client gives in EHLO, required by MX: your server's
	 * public name, such as `mail.example.com`, not the machine's.
	 */
	readonly helo: string;
	/** Default 25. */
	readonly port?: number;
}

/**
 * Seconds to wait for each step, RFC 5321 §4.5.3.2's by default. Each is a
 * number above 0, fractions allowed, at most 2 147 483.
 */
export interface SendMailTimeouts {
	/** The TCP connection, and a TLS handshake. Default 30. */
	readonly connect?: number;
	/** The 220 greeting. Default 300. */
	readonly greeting?: number;
	/** EHLO, HELO, STARTTLS, AUTH. Default 300. */
	readonly command?: number;
	/** The reply to MAIL FROM. Default 300. */
	readonly mail?: number;
	/** The reply to each RCPT TO. Default 300. */
	readonly rcpt?: number;
	/** The 354 to DATA. Default 120. */
	readonly dataStart?: number;
	/** The server taking each block of the message. Default 180. */
	readonly dataBlock?: number;
	/** The reply to the final dot. Default 600. */
	readonly dataEnd?: number;
}

/** The credentials for AUTH (RFC 4954), sent only over TLS. */
export interface SendMailAuth {
	readonly username: string;
	readonly password: string;
	/** Default PLAIN when the server offers it, else LOGIN. */
	readonly mechanism?: 'PLAIN' | 'LOGIN';
}

export interface SendMailEnvelope {
	/** The reverse-path, `local@domain`; `''` for the null sender of a bounce. */
	readonly from: string;
	/** One recipient or more, `local@domain` each. */
	readonly to: string | readonly string[];
	/**
	 * The name this client gives in EHLO: your server's public name.
	 * Required by MX; to a host, default the machine's host name.
	 */
	readonly helo?: string;
	/**
	 * Default `required` with `auth` or `secure`, else `opportunistic`;
	 * `auth` with `opportunistic` or `none` needs `allowPlaintextAuth`.
	 */
	readonly tls?: TlsMode;
	/** TLS from the first byte (port 465, RFC 8314). */
	readonly secure?: boolean;
	/** Certificates to trust besides the system's, PEM: a private CA, or a test's self-signed one. */
	readonly ca?: string | readonly string[];
	readonly auth?: SendMailAuth;
	/**
	 * Lets AUTH go without a checked certificate: in clear, or over
	 * opportunistic TLS. For a local test server only: the password crosses
	 * the network in base64.
	 */
	readonly allowPlaintextAuth?: boolean;
	/** The message's size in bytes, for SIZE, when it is a stream. */
	readonly size?: number;
	/** Asks for SMTPUTF8 (RFC 6531) though no address needs it: for UTF-8 header fields. */
	readonly smtputf8?: boolean;
	/** Turns each bare CR or LF in the message into CRLF, rather than refuse it. */
	readonly normalizeLineEnds?: boolean;
	readonly timeouts?: SendMailTimeouts;
	/** Seconds the whole delivery may take, DNS lookups included. Default 1800. */
	readonly deadline?: number;
}

/** Where and how to send one message. */
export type SendMailOptions = SendMailEnvelope &
	(HostDestination | MxDestination);

/** A delivery the server took, for some recipients at least. */
export interface SendMailResult {
	/** The recipients the server took, with its reply to each RCPT TO. */
	readonly accepted: readonly RecipientReply[];
	/** The recipients it refused: a 4xx is worth trying again, a 5xx is not. */
	readonly rejected: readonly RecipientReply[];
	/** The reply to the final dot. */
	readonly reply: Reply;
	/** The host that took the message: `host`, or the MX it was delivered to. */
	readonly host: string;
	readonly port: number;
	/** `false` in clear; `verified` when the certificate checked out against `host`. */
	readonly tls: false | { readonly verified: boolean };
	/** The session authenticated. */
	readonly authenticated: boolean;
}
