import type { Canonicalization } from './canon';
import type { DkimAlgorithm, Verdict } from './result';
import { verdict } from './result';
import {
	clip,
	colonList,
	decodeBase64Strict,
	parseTagList,
	type TagList,
	withoutFws,
} from './tags';

/** A DKIM-Signature whose tags all passed RFC 6376 §6.1.1's checks. */
export interface DkimSignature {
	readonly algorithm: DkimAlgorithm;
	readonly signature: Uint8Array;
	readonly bodyHash: Uint8Array;
	readonly headerCanon: Canonicalization;
	readonly bodyCanon: Canonicalization;
	readonly domain: string;
	readonly selector: string;
	readonly identity: string;
	readonly identityDomain: string;
	readonly signedHeaders: readonly string[];
	readonly bodyLength?: number;
	readonly timestamp?: number;
	readonly expires?: number;
}

/** A signature's tags, and the signature when they are valid or the verdict when not. */
export type ParsedSignature =
	| { readonly tags: TagList; readonly signature: DkimSignature }
	| { readonly tags?: TagList; readonly verdict: Verdict };

const REQUIRED = ['v', 'a', 'b', 'bh', 'd', 'h', 's'] as const;
const NAME =
	/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

class Refused extends Error {
	constructor(readonly verdict: Verdict) {
		super(verdict.reason);
	}
}

function permerror(reason: string): never {
	throw new Refused(verdict('permerror', reason));
}

function algorithmOf(value: string): DkimAlgorithm {
	if (value === 'rsa-sha256' || value === 'ed25519-sha256') return value;
	if (value === 'rsa-sha1') permerror('rsa-sha1 is not accepted (RFC 8301)');
	return permerror(`unsupported algorithm a=${clip(value)}`);
}

function canonOf(
	value: string | undefined,
): [Canonicalization, Canonicalization] {
	if (value === undefined) return ['simple', 'simple'];
	const [header = '', body = 'simple', ...more] = value.split('/');
	const known = (c: string): c is Canonicalization =>
		c === 'simple' || c === 'relaxed';
	if (more.length > 0 || !known(header) || !known(body)) {
		permerror(`unsupported canonicalization c=${clip(value)}`);
	}
	return [header, body];
}

function base64Of(tags: TagList, name: 'b' | 'bh'): Uint8Array {
	const bytes = decodeBase64Strict(withoutFws(tags.get(name) ?? ''));
	if (bytes === undefined || bytes.length === 0)
		permerror(`malformed ${name}=`);
	return bytes;
}

function numberOf(
	tags: TagList,
	name: 'l' | 't' | 'x',
	digits: number,
): number | undefined {
	const value = tags.get(name);
	if (value === undefined) return undefined;
	if (!new RegExp(`^\\d{1,${digits}}$`).test(value))
		permerror(`malformed ${name}=`);
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : Number.POSITIVE_INFINITY;
}

function headersOf(value: string, maxSignedHeaders: number): string[] {
	const names = colonList(value).map((name) => name.toLowerCase());
	if (names.some((name) => !FIELD_NAME.test(name))) permerror('malformed h=');
	if (names.length > maxSignedHeaders) {
		throw new Refused(
			verdict('policy', `h= lists more than ${maxSignedHeaders} header fields`),
		);
	}
	if (!names.includes('from')) permerror('From is not signed (h= has no from)');
	return names;
}

function identityOf(tags: TagList, domain: string): [string, string] {
	const identity = tags.get('i') ?? `@${domain}`;
	const at = identity.lastIndexOf('@');
	const identityDomain = identity.slice(at + 1).toLowerCase();
	if (at < 0 || !NAME.test(identityDomain)) permerror('malformed i=');
	if (identityDomain !== domain && !identityDomain.endsWith(`.${domain}`)) {
		permerror('i= is not within d=');
	}
	return [identity, identityDomain];
}

function checkTags(tags: TagList, maxSignedHeaders: number): DkimSignature {
	for (const name of REQUIRED) {
		if (!tags.has(name)) permerror(`missing required tag ${name}=`);
	}
	if (tags.get('v') !== '1')
		permerror(`unsupported version v=${clip(tags.get('v') ?? '')}`);
	const algorithm = algorithmOf(tags.get('a') ?? '');
	const [headerCanon, bodyCanon] = canonOf(tags.get('c'));
	const q = tags.get('q');
	if (q !== undefined && !colonList(q).includes('dns/txt')) {
		permerror('unsupported query method (q= has no dns/txt)');
	}
	const domain = (tags.get('d') ?? '').toLowerCase();
	if (!NAME.test(domain)) permerror('malformed d=');
	const selector = (tags.get('s') ?? '').toLowerCase();
	if (!NAME.test(selector)) permerror('malformed s=');
	const [identity, identityDomain] = identityOf(tags, domain);
	const signedHeaders = headersOf(tags.get('h') ?? '', maxSignedHeaders);
	const timestamp = numberOf(tags, 't', 12);
	const expires = numberOf(tags, 'x', 12);
	if (
		timestamp !== undefined &&
		expires !== undefined &&
		expires <= timestamp
	) {
		permerror('x= is not after t=');
	}
	const bodyLength = numberOf(tags, 'l', 76);
	return {
		algorithm,
		signature: base64Of(tags, 'b'),
		bodyHash: base64Of(tags, 'bh'),
		headerCanon,
		bodyCanon,
		domain,
		selector,
		identity,
		identityDomain,
		signedHeaders,
		...(bodyLength === undefined ? {} : { bodyLength }),
		...(timestamp === undefined ? {} : { timestamp }),
		...(expires === undefined ? {} : { expires }),
	};
}

/**
 * Reads a DKIM-Signature field (its raw text, name included) and checks
 * every tag RFC 6376 §6.1.1 asks a verifier to check. What fails is a
 * `permerror`, but an `h=` longer than `maxSignedHeaders`, which is this
 * verifier's own limit: `policy`.
 */
export function parseSignature(
	field: string,
	maxSignedHeaders: number,
): ParsedSignature {
	const parsed = parseTagList(field.slice(field.indexOf(':') + 1));
	if ('error' in parsed) return { verdict: verdict('permerror', parsed.error) };
	try {
		return {
			tags: parsed.tags,
			signature: checkTags(parsed.tags, maxSignedHeaders),
		};
	} catch (error) {
		if (error instanceof Refused)
			return { tags: parsed.tags, verdict: error.verdict };
		throw error;
	}
}
