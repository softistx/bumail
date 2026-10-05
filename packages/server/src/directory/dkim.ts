import type { Database } from 'bun:sqlite';
import { AuthError, dkimRecord } from '@bumail/auth';
import { ServerError } from '../errors';
import { checkDomain, domainOf } from './address';
import { immediate } from './database';
import { requireDomain } from './domains';

/** The selector `generate` uses when given none. */
export const DEFAULT_SELECTOR = 'bumail';

/** RSA keys are 2048 bits: what RFC 8301 asks verifiers to take, and what every DNS host stores. */
export const DKIM_KEY_BITS = 2048;

/** A domain's DKIM key, as listed: never its private half. */
export interface DkimKeyEntry {
	readonly domain: string;
	readonly selector: string;
	/** Where the record goes: `<selector>._domainkey.<domain>`. */
	readonly name: string;
	/** The TXT record to publish there: `v=DKIM1; k=rsa; p=…`. */
	readonly record: string;
	readonly created: Date;
	/** Why the stored key cannot be published, for a damaged directory: it is empty, or not an RSA public key. `record` is `''` then. */
	readonly unusable?: string;
}

/** What signing needs: the selector and the private key, PKCS #8 PEM. */
export interface DkimSigningKey {
	readonly selector: string;
	readonly privateKey: string;
}

interface KeyRow {
	domain: string;
	selector: string;
	public_key: string;
	created: number;
}

/** A selector: DNS labels of letters, digits and hyphens, lowercase, joined by dots. */
const SELECTOR =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The record of a stored key, or why it cannot be made: an empty key is no record to publish. */
function recordOf(publicKey: string): { record: string; unusable?: string } {
	if (publicKey === '') return { record: '', unusable: 'is empty' };
	try {
		return { record: dkimRecord({ publicKey }) };
	} catch (error) {
		if (!(error instanceof AuthError)) throw error;
		return { record: '', unusable: `cannot be used (${error.message})` };
	}
}

function entry(row: KeyRow): DkimKeyEntry {
	return {
		domain: row.domain,
		selector: row.selector,
		name: `${row.selector}._domainkey.${row.domain}`,
		...recordOf(row.public_key),
		created: new Date(row.created),
	};
}

/** The refusal for a key whose record cannot be published, or `undefined` for a usable key. */
export function unusableKey(key: DkimKeyEntry): ServerError | undefined {
	return key.unusable === undefined
		? undefined
		: new ServerError(
				'INVALID',
				`the stored DKIM key of ${key.domain} ${key.unusable}; bumail dkim generate ${key.domain} --replace makes a new one`,
			);
}

function pem(der: ArrayBuffer): string {
	const base64 = new Uint8Array(der).toBase64();
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** A new RSA-2048 key: its private half as PKCS #8 PEM, its public half as base64 SubjectPublicKeyInfo. */
async function newKey(): Promise<{ privateKey: string; publicKey: string }> {
	const pair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: DKIM_KEY_BITS,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;
	const [pkcs8, spki] = await Promise.all([
		crypto.subtle.exportKey('pkcs8', pair.privateKey),
		crypto.subtle.exportKey('spki', pair.publicKey),
	]);
	return {
		privateKey: pem(pkcs8),
		publicKey: new Uint8Array(spki).toBase64(),
	};
}

/**
 * The DKIM keys, one per hosted domain, in the directory's file — its
 * owner's alone (0600), as the password hashes are. Mail a user sends
 * `From` a domain with a key is signed with it.
 */
export class DkimKeys {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	#row(domain: string): KeyRow | undefined {
		return (
			this.#db
				.query<KeyRow, [string]>(
					'SELECT domain, selector, public_key, created FROM dkim_keys WHERE domain = ?',
				)
				.get(domain) ?? undefined
		);
	}

	/**
	 * Makes an RSA-2048 key for `domain`, a hosted one, under `selector`
	 * (default `bumail`): `NOT_FOUND` for a domain not hosted,
	 * `ALREADY_EXISTS` when it has a key and `replace` is not set,
	 * `INVALID` for a selector that is no DNS name. Answers what to publish.
	 */
	async generate(
		domain: string,
		options: { readonly selector?: string; readonly replace?: boolean } = {},
	): Promise<DkimKeyEntry> {
		const name = checkDomain(domain);
		const selector = (options.selector ?? DEFAULT_SELECTOR).toLowerCase();
		if (!SELECTOR.test(selector) || selector.length > 200) {
			throw new ServerError(
				'INVALID',
				'the selector must be a DNS name: letters, digits, hyphens and dots',
			);
		}
		this.#check(name, options.replace === true);
		const key = await newKey();
		return immediate(this.#db, () => {
			this.#check(name, options.replace === true);
			this.#db
				.query(
					`INSERT INTO dkim_keys (domain, selector, private_key, public_key, created)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (domain) DO UPDATE SET selector = excluded.selector,
						private_key = excluded.private_key, public_key = excluded.public_key,
						created = excluded.created`,
				)
				.run(name, selector, key.privateKey, key.publicKey, Date.now());
			return entry(this.#row(name) as KeyRow);
		});
	}

	#check(domain: string, replace: boolean): void {
		requireDomain(this.#db, domain);
		if (!replace && this.#row(domain) !== undefined) {
			throw new ServerError(
				'ALREADY_EXISTS',
				`the domain ${domain} has a DKIM key already; --replace makes a new one`,
			);
		}
	}

	/** The key of `domain`, as listed, or `undefined`. */
	get(domain: string): DkimKeyEntry | undefined {
		const name = domainOf(domain);
		const row = name === undefined ? undefined : this.#row(name);
		return row === undefined ? undefined : entry(row);
	}

	/** Every key, by domain. */
	list(): DkimKeyEntry[] {
		return this.#db
			.query<KeyRow, []>(
				'SELECT domain, selector, public_key, created FROM dkim_keys ORDER BY domain',
			)
			.all()
			.map(entry);
	}

	/** Removes the key of `domain`: mail from it goes unsigned. `NOT_FOUND`. Answers the domain. */
	remove(domain: string): string {
		const name = checkDomain(domain);
		immediate(this.#db, () => {
			if (this.#row(name) === undefined) {
				throw new ServerError(
					'NOT_FOUND',
					`the domain ${name} has no DKIM key`,
				);
			}
			this.#db.query('DELETE FROM dkim_keys WHERE domain = ?').run(name);
		});
		return name;
	}

	/** What signing mail `From` `domain` needs, or `undefined` with no key: for the server alone. */
	signingKey(domain: string): DkimSigningKey | undefined {
		const name = domainOf(domain);
		if (name === undefined) return undefined;
		const row = this.#db
			.query<{ selector: string; private_key: string }, [string]>(
				'SELECT selector, private_key FROM dkim_keys WHERE domain = ?',
			)
			.get(name);
		return row === null
			? undefined
			: { selector: row.selector, privateKey: row.private_key };
	}
}
