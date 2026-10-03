import { describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { BodyHasher } from './body';
import { canonicalizeHeader } from './canon';
import { signData } from './crypto';
import {
	EXAMPLE_BODY,
	RFC8463_ED25519_PRIVATE,
	RFC8463_MESSAGE,
	RFC8463_NOW,
	RFC8463_RECORDS,
	RFC8463_RSA_PRIVATE,
	unsigned,
} from './dkim.fixtures';
import { headerData } from './evaluate';
import { splitFields } from './headers';
import { importDkimPrivateKey } from './private-key';
import { signDkim } from './sign';
import { parseSignature } from './signature';
import { encodeBase64 } from './tags';
import { verifyDkim } from './verify';

const BH = '2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=';

describe('RFC 6376 §3.4.5, the canonicalisation examples', () => {
	const header = 'A: X\r\nB : Y\t\r\n\tZ  \r\n';
	const body = ' C \r\nD \t E\r\n\r\n\r\n';
	const fields = splitFields(header);

	test('example 1: relaxed header', () => {
		expect(
			fields.map((f) => canonicalizeHeader(f.raw, 'relaxed')).join(''),
		).toBe('a:X\r\nb:Y Z\r\n');
	});

	test('example 2: simple header, as written', () => {
		expect(
			fields.map((f) => canonicalizeHeader(f.raw, 'simple')).join(''),
		).toBe('A: X\r\nB : Y\t\r\n\tZ  \r\n');
	});

	test('examples 1 to 3: relaxed body " C\\r\\nD E\\r\\n", simple body " C \\r\\nD \\t E\\r\\n"', async () => {
		const sha = async (s: string) =>
			encodeBase64(
				new Uint8Array(
					await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
				),
			);
		const relaxed = new BodyHasher('relaxed');
		relaxed.write(new TextEncoder().encode(body));
		const simple = new BodyHasher('simple');
		simple.write(new TextEncoder().encode(body));
		const r = relaxed.end();
		const s = simple.end();
		expect(encodeBase64(r.hash)).toBe(await sha(' C\r\nD E\r\n'));
		expect(r.length).toBe(' C\r\nD E\r\n'.length);
		expect(encodeBase64(s.hash)).toBe(await sha(' C \r\nD \t E\r\n'));
		expect(s.length).toBe(' C \r\nD \t E\r\n'.length);
	});
});

describe('RFC 6376 Appendix A.2, the body hash', () => {
	const hash = (body: string, method: 'simple' | 'relaxed') => {
		const hasher = new BodyHasher(method);
		hasher.write(new TextEncoder().encode(body));
		return encodeBase64(hasher.end().hash);
	};

	test('bh=2jUSOH9… is the body with one space after "game.", under simple', () => {
		const oneSpace = EXAMPLE_BODY.replace('game.  Are', 'game. Are');
		expect(hash(oneSpace, 'simple')).toBe(BH);
	});

	test('the body as printed, two spaces, hashes to bh=2jUSOH9… only under relaxed', () => {
		expect(hash(EXAMPLE_BODY, 'relaxed')).toBe(BH);
		expect(hash(EXAMPLE_BODY, 'simple')).not.toBe(BH);
	});
});

describe('RFC 8463 Appendix A.3, the signed message', () => {
	test('both signatures verify, exactly as printed', async () => {
		const results = await verifyDkim(RFC8463_MESSAGE, {
			resolver: fixtureResolver(RFC8463_RECORDS),
			now: () => RFC8463_NOW,
		});
		expect(results.map((r) => [r.result, r.algorithm, r.selector])).toEqual([
			['pass', 'ed25519-sha256', 'brisbane'],
			['pass', 'rsa-sha256', 'test'],
		]);
		expect(results[0]).toMatchObject({
			domain: 'football.example.com',
			identity: '@football.example.com',
			timestamp: 1528637909,
			signedHeaders: [
				'from',
				'to',
				'subject',
				'date',
				'message-id',
				'from',
				'subject',
				'date',
			],
			testing: false,
		});
	});

	test('the secret keys of Appendix A.1 sign what the records of A.2 verify', async () => {
		const resolver = fixtureResolver(RFC8463_RECORDS);
		for (const [key, selector] of [
			[RFC8463_ED25519_PRIVATE, 'brisbane'],
			[RFC8463_RSA_PRIVATE, 'test'],
		] as const) {
			const signature = await signDkim(unsigned(), {
				domain: 'football.example.com',
				selector,
				privateKey: await importDkimPrivateKey(key),
				now: () => RFC8463_NOW,
			});
			const [result] = await verifyDkim(signature + unsigned(), {
				resolver,
				now: () => RFC8463_NOW,
			});
			expect(result?.result).toBe('pass');
		}
	});

	test('both b= values are reproduced byte for byte from the A.1 keys (both algorithms are deterministic)', async () => {
		const fields = splitFields(
			RFC8463_MESSAGE.slice(0, RFC8463_MESSAGE.indexOf('\r\n\r\n') + 2),
		);
		const signatures = fields.filter(
			(field) => field.name === 'dkim-signature',
		);
		const keys = [RFC8463_ED25519_PRIVATE, RFC8463_RSA_PRIVATE];
		for (const [i, field] of signatures.entries()) {
			const parsed = parseSignature(field.raw, 64);
			if (!('signature' in parsed))
				throw new Error('the RFC signature does not parse');
			const { signature } = parsed;
			const key = await importDkimPrivateKey(keys[i] as string);
			const data = headerData(fields, signature, field);
			const b = await signData(signature.algorithm, key, data);
			expect(encodeBase64(b)).toBe(encodeBase64(signature.signature));
		}
	});

	test('a changed body fails each signature on its body hash', async () => {
		const tampered = RFC8463_MESSAGE.replace('hungry', 'thirsty');
		const results = await verifyDkim(tampered, {
			resolver: fixtureResolver(RFC8463_RECORDS),
			now: () => RFC8463_NOW,
		});
		expect(results.map((r) => [r.result, r.reason])).toEqual([
			['fail', 'body hash did not verify'],
			['fail', 'body hash did not verify'],
		]);
	});

	test('a changed signed header fails each signature on its signature', async () => {
		const tampered = RFC8463_MESSAGE.replace(
			'Is dinner ready?',
			'Is lunch ready?',
		);
		const results = await verifyDkim(tampered, {
			resolver: fixtureResolver(RFC8463_RECORDS),
			now: () => RFC8463_NOW,
		});
		expect(results.map((r) => r.reason)).toEqual([
			'signature did not verify',
			'signature did not verify',
		]);
	});
});

describe('RFC 8032 §7.1, test 1: the Ed25519 key RFC 8463 signs with', () => {
	test('the seed, imported as a DKIM key, signs the empty message as RFC 8032 prints', async () => {
		const key = await importDkimPrivateKey(RFC8463_ED25519_PRIVATE);
		const signature = new Uint8Array(
			await crypto.subtle.sign('Ed25519', key, new Uint8Array()),
		);
		expect(Buffer.from(signature).toString('hex')).toBe(
			'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
		);
	});
});
