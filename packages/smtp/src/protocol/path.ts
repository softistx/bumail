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
 * C1 controls, Unicode format characters (zero-width, bidi, BOM) and the
 * line and paragraph separators: none has a place in an address, and each
 * would land as it is in the Received field and the app's records.
 */
const INVISIBLE = /[\u0080-\u009f\u2028\u2029\p{Cf}]/u;

function isDotString(text: string): boolean {
	return text.split('.').every((atom) => ATOM.test(atom));
}

function isQuotedString(text: string): boolean {
	return /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e\u0080-\u{10ffff}]|\\[\x20-\x7e])*"$/u.test(
		text,
	);
}

function isDomain(domain: string): boolean {
	if (/^\[(?:IPv6:[0-9A-Fa-f:.]+|\d{1,3}(?:\.\d{1,3}){3})\]$/.test(domain))
		return true;
	return (
		domain.length <= 255 &&
		domain.split('.').every((label) => label.length <= 63 && LABEL.test(label))
	);
}

/**
 * Parses the `<path>` of RFC 5321 §4.1.2: `<local@domain>`, with a source
 * route to ignore (`<@a,@b:local@domain>`, §C), or `<>` when `allowNull`.
 * Non-ASCII is allowed: whether the session may use it is SMTPUTF8's
 * question (RFC 6531), not the grammar's. `undefined` when it is not a path.
 *
 * The local part is kept as written, quotes included: `"v@x.example"` and
 * `v%x.example` are local parts of the domain after the last `@`, not
 * addresses elsewhere. Code that delivers must not split on the first `@`.
 */
export function parsePath(text: string, allowNull: boolean): Path | undefined {
	if (!text.startsWith('<') || !text.endsWith('>')) return undefined;
	let inner = text.slice(1, -1);
	if (INVISIBLE.test(inner)) return undefined;
	if (inner === '')
		return allowNull ? { address: '', local: '', domain: '' } : undefined;
	const route = /^@[^:]+:/.exec(inner);
	if (route) inner = inner.slice(route[0].length);
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
