import { normalizeName } from '@bumail/dns';
import { foldHeader, MimeError } from '@bumail/mime';
import { AuthError } from '../errors';
import { BodyHasher } from './body';
import {
	type Canonicalization,
	type CanonicalizationPair,
	canonicalizeHeader,
} from './canon';
import { signData } from './crypto';
import { type RawField, selectFields, splitFields } from './headers';
import { HeaderTooLarge, type MessageInput, splitMessage } from './message';
import { DNS_NAME } from './names';
import type { DkimAlgorithm } from './result';
import { givenHeaders, hasFrom, headersToSign } from './sign-headers';
import { encodeBase64 } from './tags';
import { bytesOf } from './text';

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
	/**
	 * `h=` exactly, over-signing included. By default `RECOMMENDED_HEADERS`
	 * as present, then From, Subject, Date, To, Cc, Reply-To, Message-ID,
	 * Content-Type and MIME-Version once more each, when present.
	 */
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
		!DNS_NAME.test(options.selector)
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

function maxHeaderBytesOf(options: SignDkimOptions): number {
	const maxHeaderBytes = options.maxHeaderBytes ?? 262_144;
	if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
		throw invalid(
			`maxHeaderBytes must be an integer of at least 1, not ${maxHeaderBytes}`,
		);
	}
	return maxHeaderBytes;
}

/** The header's fields and the body hash, every failure to read the message an `AuthError` `INVALID_MESSAGE`. */
async function readMessage(
	message: MessageInput,
	maxHeaderBytes: number,
	bodyCanon: Canonicalization,
): Promise<{ fields: RawField[]; bodyHash: Uint8Array }> {
	try {
		const split = await splitMessage(message, maxHeaderBytes);
		const fields = splitFields(split.header);
		if (!hasFrom(fields)) {
			await split.cancel();
			throw new AuthError(
				'INVALID_MESSAGE',
				'signDkim(): the message has no From header',
			);
		}
		const hasher = new BodyHasher(bodyCanon);
		for await (const chunk of split.body) hasher.write(chunk);
		return { fields, bodyHash: hasher.end().hash };
	} catch (error) {
		if (error instanceof AuthError) throw error;
		if (error instanceof HeaderTooLarge) {
			throw new AuthError(
				'INVALID_MESSAGE',
				`signDkim(): the header is larger than maxHeaderBytes (${maxHeaderBytes})`,
			);
		}
		throw new AuthError(
			'INVALID_MESSAGE',
			`signDkim(): the message could not be read: ${String(error)}`,
			{ cause: error },
		);
	}
}

/** The field folded by `@bumail/mime`; what it cannot fold, such as a word past 998 characters, is an `INVALID_OPTION`. */
function fold(value: string): string {
	try {
		return foldHeader('DKIM-Signature', value);
	} catch (error) {
		if (!(error instanceof MimeError)) throw error;
		throw new AuthError(
			'INVALID_OPTION',
			`signDkim(): the DKIM-Signature field cannot be written: ${error.message}`,
			{ cause: error },
		);
	}
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
	const given = givenHeaders(options.headers);
	const maxHeaderBytes = maxHeaderBytesOf(options);
	const { fields, bodyHash } = await readMessage(
		message,
		maxHeaderBytes,
		bodyCanon,
	);
	const names = headersToSign(given, fields);
	const tags = [
		'v=1',
		`a=${algorithm}`,
		`c=${headerCanon}/${bodyCanon}`,
		`d=${domain}`,
		`s=${options.selector}`,
		...(identity === undefined ? [] : [`i=${identity}`]),
		...times,
		`h=${names.join(': ')}`,
		`bh=${encodeBase64(bodyHash)}`,
	].join('; ');
	const unsigned = fold(`${tags}; b=`);
	const data =
		selectFields(fields, names)
			.map((field) => canonicalizeHeader(field.raw, headerCanon))
			.join('') + canonicalizeHeader(unsigned, headerCanon).slice(0, -2);
	const b = encodeBase64(
		await signData(algorithm, options.privateKey, bytesOf(data)),
	);
	const chunks = b.match(/.{1,72}/g) ?? [];
	return `${fold(`${tags}; b=${chunks.map((c) => ` ${c}`).join('')}`)}\r\n`;
}
