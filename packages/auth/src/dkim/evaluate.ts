import type { Resolver } from '@bumail/dns';
import type { BodyDigest } from './body';
import { canonicalizeHeader, withoutSignatureValue } from './canon';
import { rsaBits, verifyData } from './crypto';
import { type RawField, selectFields } from './headers';
import type { DkimKey } from './key';
import { type DkimResult, type Verdict, verdict } from './result';
import type { DkimSignature, ParsedSignature } from './signature';
import { type TagList, withoutFws } from './tags';
import { bytesOf, lowerAscii } from './text';

/** What `verifyDkim` checks with, its options resolved. */
export interface Settings {
	readonly resolver: Resolver;
	/** Seconds since the epoch. */
	readonly now: number;
	readonly clockSkew: number;
	readonly maxHeaderBytes: number;
	readonly maxSignatures: number;
	readonly maxSignedHeaders: number;
	readonly minRsaBits: number;
	readonly rejectBodyLength: boolean;
}

/** One signature on its way: what it said, and its key, looked up while the body streams. */
export interface Pending {
	readonly field: RawField;
	readonly signature: DkimSignature;
	readonly key: Promise<DkimKey | Verdict>;
}

/** The result fields a signature's tags give, as far as they could be read. */
export function describe(
	tags: TagList | undefined,
	signature?: DkimSignature,
): DkimResult {
	const text = (name: string) => tags?.get(name);
	const d = text('d');
	const domain =
		signature?.domain ?? (d === undefined ? undefined : lowerAscii(d));
	const selector = signature?.selector ?? text('s');
	const identity = signature?.identity ?? text('i');
	const algorithm = text('a');
	const b = text('b');
	return {
		result: 'neutral',
		testing: false,
		...(domain === undefined ? {} : { domain }),
		...(selector === undefined ? {} : { selector }),
		...(identity === undefined ? {} : { identity }),
		...(algorithm === undefined ? {} : { algorithm }),
		...(b === undefined ? {} : { signature: withoutFws(b) }),
		...(signature === undefined
			? {}
			: {
					signedHeaders: signature.signedHeaders,
					...(signature.bodyLength === undefined
						? {}
						: { bodyLength: signature.bodyLength }),
					...(signature.timestamp === undefined
						? {}
						: { timestamp: signature.timestamp }),
					...(signature.expires === undefined
						? {}
						: { expires: signature.expires }),
				}),
	};
}

/**
 * What can be refused before a key or a body: the tags, the From fields,
 * the clock, the policy. `froms` counts the message's From fields: one
 * that `h=` does not list (the signature over-signs none, and one was
 * added) is `policy`, since a reader may be shown the unsigned one.
 */
export function screen(
	parsed: ParsedSignature,
	settings: Settings,
	froms: number,
): Verdict | undefined {
	if ('verdict' in parsed) return parsed.verdict;
	const { expires, timestamp, bodyLength, signedHeaders } = parsed.signature;
	const hasFrom = froms > 0;
	if (!hasFrom) return verdict('permerror', 'the message has no From header');
	const signedFroms = signedHeaders.filter((name) => name === 'from').length;
	if (froms > signedFroms) {
		return verdict(
			'policy',
			'the message has a From the signature does not cover',
		);
	}
	if (expires !== undefined && settings.now > expires + settings.clockSkew) {
		return verdict('neutral', 'signature expired (x=)');
	}
	if (
		timestamp !== undefined &&
		timestamp > settings.now + settings.clockSkew
	) {
		return verdict('neutral', 'signature timestamp t= is in the future');
	}
	if (bodyLength !== undefined && settings.rejectBodyLength) {
		return verdict('policy', 'l= body length is refused (rejectBodyLength)');
	}
	return undefined;
}

/** The canonical header data a signature signs (§3.7): the selected fields, then the signature itself without its CRLF. */
export function headerData(
	fields: readonly RawField[],
	signature: DkimSignature,
	field: RawField,
): Uint8Array {
	const method = signature.headerCanon;
	const selected = selectFields(fields, signature.signedHeaders)
		.map((selectedField) => canonicalizeHeader(selectedField.raw, method))
		.join('');
	const own = canonicalizeHeader(
		withoutSignatureValue(field.raw),
		method,
	).slice(0, -2);
	return bytesOf(selected + own);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The key's own refusals once imported: its size, and strict `t=s`. */
function keyVerdict(
	key: DkimKey,
	signature: DkimSignature,
	settings: Settings,
): Verdict | undefined {
	if (key.strict && signature.identityDomain !== signature.domain) {
		return verdict(
			'permerror',
			'key t=s: i= must be in d= itself, not a subdomain',
		);
	}
	if (key.type !== 'rsa') return undefined;
	const bits = rsaBits(key.key);
	if (bits < 1024)
		return verdict(
			'permerror',
			`RSA key of ${bits} bits, under 1024 (RFC 8301)`,
		);
	if (bits < settings.minRsaBits) {
		return verdict(
			'policy',
			`RSA key of ${bits} bits, under minRsaBits (${settings.minRsaBits})`,
		);
	}
	return undefined;
}

/** Ends one signature's check (§6.1.2, §6.1.3): its key, its body hash, then its signature. */
export async function finish(
	pending: Pending,
	digest: BodyDigest,
	fields: readonly RawField[],
	settings: Settings,
): Promise<{
	verdict?: Verdict;
	testing: boolean;
	unsignedBodyLength?: number;
}> {
	const { signature } = pending;
	const key = await pending.key;
	if ('reason' in key) return { verdict: key, testing: false };
	const testing = key.testing;
	const refused = keyVerdict(key, signature, settings);
	if (refused !== undefined) return { verdict: refused, testing };
	const limit = signature.bodyLength;
	if (limit !== undefined && limit > digest.length) {
		return {
			verdict: verdict('permerror', 'l= is longer than the canonical body'),
			testing,
		};
	}
	const unsigned =
		limit === undefined ? {} : { unsignedBodyLength: digest.length - limit };
	if (!equal(digest.hash, signature.bodyHash)) {
		return {
			verdict: verdict('fail', 'body hash did not verify'),
			testing,
			...unsigned,
		};
	}
	const data = headerData(fields, signature, pending.field);
	if (
		!(await verifyData(signature.algorithm, key.key, data, signature.signature))
	) {
		return {
			verdict: verdict('fail', 'signature did not verify'),
			testing,
			...unsigned,
		};
	}
	return { testing, ...unsigned };
}
