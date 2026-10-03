/** An envelope address, as `MAIL FROM` and `RCPT TO` give it. */
export interface Path {
	/** `local@domain`; `''` for the null reverse-path `<>`. */
	readonly address: string;
	readonly local: string;
	/** Lower case. */
	readonly domain: string;
}

const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\u{10ffff}]+$/u;
const LABEL =
	/^(?:[A-Za-z0-9\u0080-\u{10ffff}](?:[A-Za-z0-9\-\u0080-\u{10ffff}]*[A-Za-z0-9\u0080-\u{10ffff}])?)$/u;

/**
 * C1 controls, Unicode format characters (zero-width, bidi, BOM), the
 * line and paragraph separators, and lone surrogates: none has a place in
 * an address, and each would land as it is in the Received field and the
 * app's records — a lone surrogate as U+FFFD, once encoded for the wire.
 */
const INVISIBLE = /[\u0080-\u009f\u2028\u2029\p{Cf}\p{Cs}]/u;

/**
 * C0 controls (CR, LF and NUL among them), DEL and `>`, anywhere in the
 * path, quoted or not: a CR or an LF would end the command line and start
 * another, and a `>` would end the path where a reader of the line stops.
 */
function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f || code === 0x3e) return true;
	}
	return false;
}

/** One hop of a source route, `@domain`, and what follows it: `,` or `:`. */
const HOP = /^@(\[[^\]]*\]|[^,:@[\]]*)([,:])/;

function isDotString(text: string): boolean {
	return text.split('.').every((atom) => ATOM.test(atom));
}

function isQuotedString(text: string): boolean {
	return /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e\u0080-\u{10ffff}]|\\[\x20-\x7e])*"$/u.test(
		text,
	);
}

/**
 * An address literal (§4.1.3): `[IPv6:…]`, its tag in any case (a quoted
 * string in RFC 5234 is), or `[a.b.c.d]` with each octet at most 255.
 */
export function isAddressLiteral(text: string): boolean {
	if (/^\[IPv6:[0-9a-f:.]+\]$/i.test(text)) return true;
	const ipv4 = /^\[(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\]$/.exec(text);
	return ipv4?.slice(1).every((octet) => Number(octet) <= 255) === true;
}

/**
 * The argument of EHLO or HELO (RFC 5321 §4.1.1.1): a host name of
 * letters, digits and hyphens, or an address literal.
 */
export function isHelloName(text: string): boolean {
	return (
		/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(text) || isAddressLiteral(text)
	);
}

function isDomain(domain: string): boolean {
	if (isAddressLiteral(domain)) return true;
	return (
		domain.length <= 255 &&
		domain.split('.').every((label) => label.length <= 63 && LABEL.test(label))
	);
}

/**
 * What `parsePath` does with a source route (`<@a,@b:local@domain>`, RFC 5321
 * Appendix C): a server accepts and discards it (`'discard'`), a client
 * refuses it, as §4.1.1.3 says clients should not send one (`'refuse'`).
 */
export type SourceRoute = 'discard' | 'refuse';

/**
 * The mailbox after a source route, each of whose hops must be
 * `@domain` with a valid domain; `undefined` for any other route.
 */
function afterRoute(inner: string): string | undefined {
	let rest = inner;
	for (;;) {
		const hop = HOP.exec(rest);
		if (!hop || !isDomain(hop[1] as string)) return undefined;
		rest = rest.slice(hop[0].length);
		if (hop[2] === ':') return rest;
	}
}

/**
 * Parses the `<path>` of RFC 5321 §4.1.2: `<local@domain>`, or `<>` when
 * `allowNull`. A source route (`<@a,@b:local@domain>`, §C) is dropped when
 * `sourceRoute` is `'discard'`, the default, provided each hop is
 * `@domain`; with `'refuse'` the path is not one. A C0 control (CR, LF,
 * NUL…), DEL or `>` anywhere refuses the path, as do C1 controls,
 * Unicode format characters and lone surrogates. An IPv4 address literal
 * takes octets up to 255.
 * Non-ASCII is allowed: whether the session may use it is SMTPUTF8's
 * question (RFC 6531), not the grammar's. `undefined` when it is not a path.
 *
 * The local part is kept as written, quotes included: `"v@x.example"` and
 * `v%x.example` are local parts of the domain after the last `@`, not
 * addresses elsewhere. Code that delivers must not split on the first `@`.
 */
export function parsePath(
	text: string,
	allowNull: boolean,
	sourceRoute: SourceRoute = 'discard',
): Path | undefined {
	if (!text.startsWith('<') || !text.endsWith('>')) return undefined;
	let inner: string | undefined = text.slice(1, -1);
	if (hasControl(inner) || INVISIBLE.test(inner)) return undefined;
	if (inner === '')
		return allowNull ? { address: '', local: '', domain: '' } : undefined;
	if (inner.startsWith('@')) {
		if (sourceRoute === 'refuse') return undefined;
		inner = afterRoute(inner);
		if (inner === undefined) return undefined;
	}
	const at = inner.lastIndexOf('@');
	if (at <= 0) return undefined;
	const local = inner.slice(0, at);
	const domain = inner.slice(at + 1);
	if (local.length > 64 || !(isDotString(local) || isQuotedString(local)))
		return undefined;
	if (!isDomain(domain)) return undefined;
	return {
		address: `${local}@${domain.toLowerCase()}`,
		local,
		domain: domain.toLowerCase(),
	};
}
