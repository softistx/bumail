import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { AuthError } from '../errors';
import { keyPair, unsigned } from './dkim.fixtures';
import { type SignDkimOptions, signDkim } from './sign';
import { type VerifyDkimOptions, verifyDkim } from './verify';

const NOW = 1_700_000_000_000;

async function signed(
	record: (base: string) => string = (base) => base,
	options: Partial<SignDkimOptions> = {},
	message = unsigned(),
) {
	const {
		privateKey,
		record: base,
		publicKey,
	} = await keyPair('ed25519-sha256');
	const signature = await signDkim(message, {
		domain: 'example.com',
		selector: 'sel',
		privateKey,
		now: () => NOW,
		...options,
	});
	const resolver = fixtureResolver({
		'sel._domainkey.example.com': { txt: [record(base)] },
	});
	return {
		signature,
		resolver,
		publicKey,
		privateKey,
		message: signature + message,
	};
}

async function one(message: string, options: VerifyDkimOptions) {
	const [result] = await verifyDkim(message, options);
	return result;
}

describe('verifyDkim', () => {
	test('honours x= and t= with clockSkew', async () => {
		const { message, resolver } = await signed(undefined, { expiresIn: 60 });
		const at = (seconds: number, clockSkew?: number) =>
			one(message, {
				resolver,
				now: () => NOW + seconds * 1000,
				...(clockSkew === undefined ? {} : { clockSkew }),
			});
		expect((await at(60 + 300))?.result).toBe('pass');
		expect(await at(60 + 301)).toMatchObject({
			result: 'neutral',
			reason: 'signature expired (x=)',
		});
		expect(await at(61, 0)).toMatchObject({
			result: 'neutral',
			reason: 'signature expired (x=)',
		});
		expect((await at(-300))?.result).toBe('pass');
		expect(await at(-301)).toMatchObject({
			result: 'neutral',
			reason: 'signature timestamp t= is in the future',
		});
		expect(await at(0)).toMatchObject({
			timestamp: NOW / 1000,
			expires: NOW / 1000 + 60,
		});
	});

	test('reports t=y testing, and t=s strict refuses an i= in a subdomain', async () => {
		const testing = await signed((base) => `${base}; t=y`);
		expect(
			await one(testing.message, {
				resolver: testing.resolver,
				now: () => NOW,
			}),
		).toMatchObject({
			result: 'pass',
			testing: true,
		});
		const strict = await signed((base) => `${base}; t=s:y`, {
			identity: 'joe@mail.example.com',
		});
		expect(
			await one(strict.message, { resolver: strict.resolver, now: () => NOW }),
		).toMatchObject({
			result: 'permerror',
			reason: 'key t=s: i= must be in d= itself, not a subdomain',
			testing: true,
		});
		const exact = await signed((base) => `${base}; t=s`, {
			identity: 'joe@example.com',
		});
		expect(
			(await one(exact.message, { resolver: exact.resolver, now: () => NOW }))
				?.result,
		).toBe('pass');
	});

	test('honours l= and reports what it leaves unsigned; rejectBodyLength refuses it', async () => {
		const { privateKey, record } = await keyPair('ed25519-sha256');
		const resolver = fixtureResolver({
			'sel._domainkey.example.com': { txt: [record] },
		});
		// The signer never writes l=; a signature with l= is built from the canonical body by hand.
		const body = 'Hi.\r\n';
		const { BodyHasher } = await import('./body');
		const hasher = new BodyHasher('relaxed', 5);
		hasher.write(new TextEncoder().encode(body));
		const { headerData } = await import('./evaluate');
		const { parseSignature } = await import('./signature');
		const { splitFields } = await import('./headers');
		const { signData } = await import('./crypto');
		const { encodeBase64 } = await import('./tags');
		const tags = `v=1; a=ed25519-sha256; c=relaxed/relaxed; d=example.com; s=sel; l=5; h=from; bh=${encodeBase64(hasher.end().hash)}; b=`;
		const field = `DKIM-Signature: ${tags}`;
		const header = 'From: joe@example.com\r\n';
		const parsed = parseSignature(`${field}AAAA`, 64);
		if (!('signature' in parsed)) throw new Error('unparsed');
		const fields = splitFields(`${field}AAAA\r\n${header}`);
		const data = headerData(fields, parsed.signature, fields[0] as never);
		const b = encodeBase64(await signData('ed25519-sha256', privateKey, data));
		const message = `${field}${b}\r\n${header}\r\n${body}Appended by anyone.\r\n`;
		expect(await one(message, { resolver })).toMatchObject({
			result: 'pass',
			bodyLength: 5,
			unsignedBodyLength: 'Appended by anyone.\r\n'.length,
		});
		expect(
			await one(message, { resolver, rejectBodyLength: true }),
		).toMatchObject({
			result: 'policy',
			reason: 'l= body length is refused (rejectBodyLength)',
		});
	});

	test('over-signed From refuses a From added on top', async () => {
		const { message, resolver } = await signed();
		expect((await one(message, { resolver, now: () => NOW }))?.result).toBe(
			'pass',
		);
		expect(
			await one(`From: mallory@example.net\r\n${message}`, {
				resolver,
				now: () => NOW,
			}),
		).toMatchObject({
			result: 'fail',
			reason: 'signature did not verify',
		});
	});

	test('one result per signature, in order, the ones past maxSignatures as policy', async () => {
		const first = await signed();
		const resolver = first.resolver;
		const message = first.signature + first.message;
		const results = await verifyDkim(message, {
			resolver,
			now: () => NOW,
			maxSignatures: 1,
		});
		expect(results.map((r) => [r.result, r.reason])).toEqual([
			['pass', undefined],
			['policy', 'more than 1 signatures (maxSignatures)'],
		]);
	});

	test('takes the first TXT record that is a key, and a bare RSAPublicKey p=', async () => {
		const { privateKey, publicKey } = await keyPair('rsa-sha256');
		const signature = await signDkim(unsigned(), {
			domain: 'example.com',
			selector: 'sel',
			privateKey,
		});
		// SubjectPublicKeyInfo of a 1024-bit key: the RSAPublicKey is the BIT STRING after 22 bytes of header.
		const pkcs1 = Buffer.from(publicKey.subarray(22)).toString('base64');
		const resolver = fixtureResolver({
			'sel._domainkey.example.com': {
				txt: ['v=spf1 -all', `v=DKIM1; p=${pkcs1}`],
			},
		});
		expect((await one(signature + unsigned(), { resolver }))?.result).toBe(
			'pass',
		);
	});

	test('a header past maxHeaderBytes, and a stream that fails, are results too', async () => {
		const resolver = fixtureResolver({});
		expect(
			await verifyDkim(unsigned(), { resolver, maxHeaderBytes: 16 }),
		).toEqual([
			{
				result: 'permerror',
				reason: 'the header is larger than maxHeaderBytes (16)',
				testing: false,
			},
		]);
		const { message, resolver: keys } = await signed();
		let sent = false;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) controller.error(new Error('connection reset'));
				else
					controller.enqueue(
						new TextEncoder().encode(message.slice(0, message.indexOf('Hi.'))),
					);
				sent = true;
			},
		});
		expect(
			await one(failing as never, { resolver: keys, now: () => NOW }),
		).toMatchObject({
			result: 'temperror',
			reason: 'the message could not be read: Error: connection reset',
			domain: 'example.com',
		});
	});

	test('refuses options it cannot take', async () => {
		const resolver = fixtureResolver({});
		const refusal = async (options: VerifyDkimOptions) => {
			try {
				await verifyDkim(unsigned(), options);
			} catch (error) {
				return error instanceof AuthError
					? `${error.code}: ${error.message}`
					: 'other';
			}
			return 'none';
		};
		expect(await refusal({ resolver, maxSignatures: 0 })).toBe(
			'INVALID_OPTION: verifyDkim(): maxSignatures must be an integer of at least 1, not 0',
		);
		expect(await refusal({ resolver, minRsaBits: 512 })).toBe(
			'INVALID_OPTION: verifyDkim(): minRsaBits must be an integer of at least 1024, not 512',
		);
		expect(await refusal({} as never)).toBe(
			'INVALID_OPTION: verifyDkim(): resolver must be a Resolver',
		);
	});
});
