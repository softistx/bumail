import { normalizeName } from '@bumail/dns';
import { foldHeader } from '@bumail/mime';
import { AuthError } from '../errors';
import { BodyHasher } from './body';
import { type CanonicalizationPair, canonicalizeHeader } from './canon';
import { signData } from './crypto';
import { type RawField, selectFields, splitFields } from './headers';
import {
	bytesOf,
	HeaderTooLarge,
	type MessageInput,
	splitMessage,
} from './message';
import type { DkimAlgorithm } from './result';
import { encodeBase64 } from './tags';

/** What `signDkim` signs with. */
export interface SignDkimOptions {
	/** `d=`, the signing domain; an IDN is written as its A-labels. */
	readonly domain: string;
	/** `s=`: the key record is at `<selector>._domainkey.<domain>`. */
	readonly selector: string;
	/** An RSASSA-PKCS1-v1_5 SHA-256 key, or an Ed25519 key, with the `sign` usage. */
	readonly privateKey: CryptoKey;
	/** Taken from the key when left out. */
	readonly algorithm?: DkimAlgorithm;
	/** `h=` exactly, over-signing included; by default RFC 6376 §5.4.1's set as present, and From once more. */
	readonly headers?: readonly string[];
	/** `c=`; `relaxed/relaxed` by default. */
	readonly canonicalization?: CanonicalizationPair;
	/** `i=`; it must be within the domain. Left out by default (it is then `@` and the domain). */
	readonly identity?: string;
	/** Seconds the signature is valid for: `x=` is `t=` plus this. No `x=` by default. */
	readonly expiresIn?: number;
	/** The clock, in milliseconds: `Date.now` by default. */
	readonly now?: () => number;
	/** Bytes the header may take. 256 KiB by default. */
	readonly maxHeaderBytes?: number;
}

/** RFC 6376 §5.4.1's recommended fields, and Message-ID, which it calls useful. */
export const RECOMMENDED_HEADERS: readonly string[] = [
	'from',
	'reply-to',
	'subject',
	'date',
	'to',
	'cc',
	'message-id',
	'resent-date',
	'resent-from',
	'resent-to',
	'resent-cc',
	'in-reply-to',
	'references',
	'list-id',
	'list-help',
	'list-unsubscribe',
	'list-subscribe',
	'list-post',
	'list-owner',
	'list-archive',
];

const SELECTOR =
	/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

function invalid(message: string): AuthError {
	return new AuthError('INVALID_OPTION', `signDkim(): ${message}`);
}

function algorithmOf(options: SignDkimOptions): DkimAlgorithm {
	const name = options.privateKey?.algorithm?.name;
	const fromKey =
		name === 'Ed25519'
			? 'ed25519-sha256'
			: name === 'RSASSA-PKCS1-v1_5'
				? 'rsa-sha256'
				: undefined;
	if (fromKey === undefined)
		throw invalid(
			`privateKey must be an RSASSA-PKCS1-v1_5 or Ed25519 CryptoKey, not ${String(name)}`,
		);
	if (options.algorithm !== undefined && options.algorithm !== fromKey) {
		throw invalid(
			`algorithm ${options.algorithm} does not match the ${name} key`,
		);
	}
	const hash = (options.privateKey.algorithm as RsaHashedKeyAlgorithm).hash
		?.name;
	if (fromKey === 'rsa-sha256' && hash !== 'SHA-256')
		throw invalid(`the RSA key's hash must be SHA-256, not ${String(hash)}`);
	if (!options.privateKey.usages.includes('sign'))
		throw invalid('privateKey does not have the sign usage');
	return fromKey;
}

function domainOf(options: SignDkimOptions): {
	domain: string;
	identity?: string;
} {
	let domain: string;
	try {
		domain = normalizeName(options.domain);
	} catch {
		throw invalid(`domain "${String(options.domain)}" is not a domain name`);
	}
	if (
		typeof options.selector !== 'string' ||
		!SELECTOR.test(options.selector)
	) {
		throw invalid(`selector "${String(options.selector)}" is not a selector`);
	}
	const identity = options.identity;
	if (identity === undefined) return { domain };
	const at = identity.lastIndexOf('@');
	const of = identity.slice(at + 1).toLowerCase();
	if (
		at < 0 ||
		/[^\x21-\x3a\x3c-\x7e]/.test(identity) ||
		(of !== domain && !of.endsWith(`.${domain}`))
	) {
		throw invalid(`identity "${identity}" is not an address within ${domain}`);
	}
	return { domain, identity };
}

function headersOf(
	options: SignDkimOptions,
	fields: readonly RawField[],
): string[] {
	if (!fields.some((field) => field.name === 'from')) {
		throw new AuthError(
			'INVALID_MESSAGE',
			'signDkim(): the message has no From header',
		);
	}
	if (options.headers === undefined) {
		const present = fields
			.map((field) => field.name)
			.filter((name) => RECOMMENDED_HEADERS.includes(name));
		return [...present, 'from'];
	}
	const names = options.headers.map((name) => name.toLowerCase());
	if (names.some((name) => !FIELD_NAME.test(name)))
		throw invalid('headers holds a name that is not a header field name');
	if (!names.includes('from'))
		throw invalid('headers must include from (RFC 6376 §5.4)');
	return names;
}

function canonOf(
	options: SignDkimOptions,
): ['simple' | 'relaxed', 'simple' | 'relaxed'] {
	const pair = options.canonicalization ?? 'relaxed/relaxed';
	const [header, body] = pair.split('/');
	const known = (c: string | undefined): c is 'simple' | 'relaxed' =>
		c === 'simple' || c === 'relaxed';
	if (!known(header) || !known(body) || pair.split('/').length !== 2)
		throw invalid(
			`canonicalization ${pair} is not one of simple|relaxed/simple|relaxed`,
		);
	return [header, body];
}

function timesOf(options: SignDkimOptions): string[] {
	const t = Math.floor((options.now ?? Date.now)() / 1000);
	if (options.expiresIn === undefined) return [`t=${t}`];
	if (!Number.isSafeInteger(options.expiresIn) || options.expiresIn < 1) {
		throw invalid(
			`expiresIn must be an integer of at least 1, not ${options.expiresIn}`,
		);
	}
	return [`t=${t}`, `x=${t + options.expiresIn}`];
}

/**
 * Signs a message (RFC 6376 §5) and returns the `DKIM-Signature` field to
 * put on top of it, folded at 78 columns, `b=` last, ending with CRLF:
 * `signature + message` is the signed message. The body is streamed and
 * hashed with bounded memory.
 */
export async function signDkim(
	message: MessageInput,
	options: SignDkimOptions,
): Promise<string> {
	const algorithm = algorithmOf(options);
	const { domain, identity } = domainOf(options);
	const [headerCanon, bodyCanon] = canonOf(options);
	const times = timesOf(options);
	const maxHeaderBytes = options.maxHeaderBytes ?? 262_144;
	if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
		throw invalid(
			`maxHeaderBytes must be an integer of at least 1, not ${maxHeaderBytes}`,
		);
	}
	const split = await splitMessage(message, maxHeaderBytes).catch(
		(error: unknown) => {
			if (error instanceof HeaderTooLarge) {
				throw new AuthError(
					'INVALID_MESSAGE',
					`signDkim(): the header is larger than maxHeaderBytes (${maxHeaderBytes})`,
				);
			}
			throw error;
		},
	);
	const fields = splitFields(split.header);
	const names = headersOf(options, fields);
	const hasher = new BodyHasher(bodyCanon);
	for await (const chunk of split.body) hasher.write(chunk);
	const tags = [
		'v=1',
		`a=${algorithm}`,
		`c=${headerCanon}/${bodyCanon}`,
		`d=${domain}`,
		`s=${options.selector}`,
		...(identity === undefined ? [] : [`i=${identity}`]),
		...times,
		`h=${names.join(': ')}`,
		`bh=${encodeBase64(hasher.end().hash)}`,
	].join('; ');
	const unsigned = foldHeader('DKIM-Signature', `${tags}; b=`);
	const data =
		selectFields(fields, names)
			.map((field) => canonicalizeHeader(field.raw, headerCanon))
			.join('') + canonicalizeHeader(unsigned, headerCanon).slice(0, -2);
	const b = encodeBase64(
		await signData(algorithm, options.privateKey, bytesOf(data)),
	);
	const chunks = b.match(/.{1,72}/g) ?? [];
	return `${foldHeader('DKIM-Signature', `${tags}; b=${chunks.map((c) => ` ${c}`).join('')}`)}\r\n`;
}
