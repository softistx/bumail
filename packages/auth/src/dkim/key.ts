import { DnsError, type Resolver } from '@bumail/dns';
import { type DkimKeyType, importPublicKey, keyTypeOf } from './crypto';
import type { DkimAlgorithm, Verdict } from './result';
import { verdict } from './result';
import {
	colonList,
	decodeBase64Strict,
	parseTagList,
	withoutFws,
} from './tags';

/** A key record's tags (RFC 6376 §3.6.1), read but not yet imported. */
export interface KeyRecord {
	/** `k=`, `rsa` by default. */
	readonly type: string;
	/** `p=` without its white space; empty when the key is revoked. */
	readonly publicKey: string;
	/** `h=`, every hash when absent. */
	readonly hashes?: readonly string[];
	/** `s=`, `*` when absent. */
	readonly services: readonly string[];
	/** `t=`'s flags. */
	readonly flags: readonly string[];
}

/** A public key ready to verify with. */
export interface DkimKey {
	readonly type: DkimKeyType;
	readonly key: CryptoKey;
	/** `t=y`. */
	readonly testing: boolean;
	/** `t=s`: `i=`'s domain must be `d=` itself. */
	readonly strict: boolean;
}

/** A key record's tags, or `undefined` when the text is not one (§3.6.1: a `v=` other than `DKIM1`, or not first, is discarded). */
export function parseKeyRecord(text: string): KeyRecord | undefined {
	const parsed = parseTagList(text);
	if ('error' in parsed) return undefined;
	const tags = parsed.tags;
	const version = tags.get('v');
	if (
		version !== undefined &&
		(version !== 'DKIM1' || tags.keys().next().value !== 'v')
	) {
		return undefined;
	}
	const publicKey = tags.get('p');
	if (publicKey === undefined) return undefined;
	const hashes = tags.get('h');
	return {
		type: tags.get('k') ?? 'rsa',
		publicKey: withoutFws(publicKey),
		...(hashes === undefined ? {} : { hashes: colonList(hashes) }),
		services: colonList(tags.get('s') ?? '*'),
		flags: colonList(tags.get('t') ?? ''),
	};
}

/** The key record's own refusals, before any import (§6.1.2). */
function refusal(
	record: KeyRecord,
	algorithm: DkimAlgorithm,
): Verdict | undefined {
	if (record.publicKey === '')
		return verdict('permerror', 'key revoked (empty p=)');
	if (record.type !== keyTypeOf(algorithm)) {
		return verdict(
			'permerror',
			`key type k=${record.type} does not match a=${algorithm}`,
		);
	}
	if (record.hashes !== undefined && !record.hashes.includes('sha256')) {
		return verdict('permerror', 'key h= does not allow sha256');
	}
	if (!record.services.includes('*') && !record.services.includes('email')) {
		return verdict('permerror', 'key s= is not for email');
	}
	return undefined;
}

/** The key record's TXT answers, or the verdict for a DNS failure (§6.1.2, RFC 8601 §2.7.1). */
async function lookUp(
	resolver: Resolver,
	name: string,
): Promise<readonly string[] | Verdict> {
	try {
		return (await resolver.txt(name)).map((record) => record.text);
	} catch (error) {
		if (!(error instanceof DnsError)) {
			return verdict('temperror', `key lookup failed: ${String(error)}`);
		}
		if (error.code === 'NOT_FOUND')
			return verdict('permerror', `no key at ${name}`);
		if (error.code === 'INVALID_NAME')
			return verdict('permerror', `no key: ${name} is not a name to look up`);
		return verdict('temperror', `key lookup failed: ${error.code} for ${name}`);
	}
}

/**
 * Looks the key up at `<s>._domainkey.<d>` and imports it. Of several TXT
 * records, the first that reads as a key record is used. Every failure is
 * a verdict, never a throw: `temperror` when the DNS gave no answer,
 * `permerror` for anything else.
 */
export async function fetchKey(
	resolver: Resolver,
	selector: string,
	domain: string,
	algorithm: DkimAlgorithm,
): Promise<DkimKey | Verdict> {
	const name = `${selector}._domainkey.${domain}`;
	const texts = await lookUp(resolver, name);
	if (!Array.isArray(texts)) return texts as Verdict;
	const record = texts.map(parseKeyRecord).find((found) => found !== undefined);
	if (record === undefined)
		return verdict('permerror', `malformed key record at ${name}`);
	const refused = refusal(record, algorithm);
	if (refused !== undefined) return refused;
	const bytes = decodeBase64Strict(record.publicKey);
	if (bytes === undefined) return verdict('permerror', 'key p= is not base64');
	const key = await importPublicKey(keyTypeOf(algorithm), bytes);
	if (key === undefined) {
		return verdict(
			'permerror',
			`key p= is not an ${keyTypeOf(algorithm)} public key`,
		);
	}
	return {
		type: keyTypeOf(algorithm),
		key,
		testing: record.flags.includes('y'),
		strict: record.flags.includes('s'),
	};
}
