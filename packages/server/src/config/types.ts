/**
 * The configuration `readConfig` gives back: every default filled in,
 * every `*File` read, every environment override applied. Nothing in it
 * is optional unless leaving it out means something.
 */
export interface ServerConfig {
	/** The file it was read from. */
	readonly file: string;
	/** The server's own name: its MX host, its HELO, the name on its certificate. */
	readonly hostname: string;
	/**
	 * Where mail for the bare `<postmaster>` (RFC 5321 §4.5.1) goes: an
	 * address the directory resolves. `undefined`: `postmaster@` the first
	 * hosted domain, by name, when the directory resolves it.
	 */
	readonly postmaster: string | undefined;
	/** The directory everything is kept in: the mail, the queue, the directory, the certificates. Default `/data`. */
	readonly data: string;
	/** The address every public listener binds to. Default `0.0.0.0`. */
	readonly bind: string;
	readonly ports: PortsConfig;
	readonly store: StoreConfig;
	readonly queue: QueueConfig;
	readonly directory: DirectoryConfig;
	readonly tls: TlsConfig;
	/** Only with `tls.mode` `'acme'`. */
	readonly acme: AcmeConfig | undefined;
	/** Where outbound mail goes when it does not go by MX; `undefined` delivers by MX. */
	readonly smarthost: SmarthostConfig | undefined;
	/** A route per recipient domain, lowercase, over the default route. */
	readonly routes: Readonly<Record<string, RouteConfig>>;
	readonly inbound: InboundConfig;
	readonly submission: SubmissionConfig;
	readonly jmap: JmapConfig;
}

/** Each listener's port; 0 turns it off. */
export interface PortsConfig {
	/** SMTP from other servers. Default 25. */
	readonly mx: number;
	/** Submission over implicit TLS (RFC 8314). Default 465. */
	readonly submissions: number;
	/** Submission with STARTTLS. Default 587. */
	readonly submission: number;
	/** IMAP over implicit TLS. Default 993. */
	readonly imaps: number;
	/** IMAP with STARTTLS. Default 0, off. */
	readonly imap: number;
	/** JMAP over HTTPS. Default 443. */
	readonly https: number;
	/** ACME's HTTP-01 challenges. Default 80. */
	readonly http: number;
	/** The health check, on loopback only. Default 8080. */
	readonly health: number;
}

/** The mailbox store, by URL: `sqlite:<directory>` or `postgres://…`. */
export interface StoreConfig {
	/** Default `sqlite:<data>/mail`. */
	readonly url: string;
	/** `true`: it sends credentials in clear, as `sslmode=disable` or `insecure = true` chose. */
	readonly plaintext: boolean;
}

/** The outbound queue, by URL: `sqlite:<directory>`, `postgres://…` or `redis://…`. */
export interface QueueConfig {
	/** Default `sqlite:<data>/queue`. */
	readonly url: string;
	/** `true`: it sends credentials in clear, as `sslmode=disable` or `insecure = true` chose. */
	readonly plaintext: boolean;
}

/** Domains, users and aliases, by URL: `sqlite:<file>`. */
export interface DirectoryConfig {
	/** Default `sqlite:<data>/directory.sqlite`. */
	readonly url: string;
}

/** Where the certificate comes from. */
export type TlsConfig =
	| { readonly mode: 'acme' }
	| {
			readonly mode: 'files';
			/** The certificate chain, PEM, leaf first. */
			readonly cert: string;
			/** Its private key, PEM. */
			readonly key: string;
	  };

/** Certificates from an ACME directory (RFC 8555), by HTTP-01 on `ports.http`. */
export interface AcmeConfig {
	/** The account's contact. */
	readonly email: string;
	/** Must be `true`: the CA's terms of service, accepted. */
	readonly acceptTerms: true;
	/** Default Let's Encrypt's production directory. */
	readonly directory: string;
}

/** How a smarthost connection is encrypted, as `@bumail/smtp/client` takes it. */
export type SmarthostTls = 'required' | 'opportunistic' | 'none';

/** A relay that takes every outbound message: a provider's submission port. */
export interface SmarthostConfig {
	readonly host: string;
	/** Default 465 with `secure`, else 587. */
	readonly port: number;
	/** TLS from the first byte. Default `true` on port 465. */
	readonly secure: boolean;
	/** STARTTLS. Default `required`. */
	readonly tls: SmarthostTls;
	readonly username: string | undefined;
	/** From `password`, `passwordFile` or `BUMAIL_SMARTHOST_PASSWORD`. */
	readonly password: string | undefined;
}

/** `'mx'`, `'smarthost'` (the one configured), or a host of its own. */
export type RouteConfig =
	| 'mx'
	| 'smarthost'
	| {
			readonly host: string;
			readonly port: number;
			readonly secure: boolean;
			readonly tls: SmarthostTls;
	  };

/** Mail from other servers, on `ports.mx`. */
export interface InboundConfig {
	/** `enforce`: `p=reject` is refused, `p=quarantine` goes to Junk. `mark`: only recorded. Default `enforce`. */
	readonly dmarc: 'enforce' | 'mark';
	/** Bytes. Default 25 MiB. */
	readonly maxMessageSize: number;
	/** Default 1000. */
	readonly maxConnections: number;
	/** At once from one client: an IPv4 address, or an IPv6 /64. Default 10. */
	readonly maxConnectionsPerClient: number;
	/**
	 * Bytes the messages waiting to be checked may hold on disk at once;
	 * past it, MAIL FROM and DATA answer `452 4.3.1`. At least
	 * `maxMessageSize`. Default 20 times `maxMessageSize`.
	 */
	readonly spoolBytes: number;
}

/** Mail from the server's own users, on `ports.submissions` and `ports.submission`. */
export interface SubmissionConfig {
	/** Bytes. Default 25 MiB. */
	readonly maxMessageSize: number;
	/** Recipients per message. Default 100. */
	readonly maxRecipients: number;
	/** Default 1000. */
	readonly maxConnections: number;
	/** At once from one client: an IPv4 address, or an IPv6 /64. Default 10. */
	readonly maxConnectionsPerClient: number;
	/** Seconds a client on `ports.submissions` has to complete its TLS handshake. Default 10. */
	readonly handshakeTimeout: number;
}

/** JMAP, on `ports.https`. */
export interface JmapConfig {
	/** The origin clients reach it at. Default `https://<hostname>`, with the port when it is neither 443 nor 0. */
	readonly origin: string;
}
