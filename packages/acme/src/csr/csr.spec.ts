import { describe, expect, test } from 'bun:test';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
	child,
	type DerNode,
	derToP1363,
	readDer,
	readInteger,
	readOid,
	readText,
} from '../der/read.fixtures';
import { pem } from '../encoding';
import { AcmeError } from '../errors';
import { generateKeyPair } from '../keys/keys';
import { OPENSSL, openssl } from '../openssl.fixtures';
import { createCsr, OID } from './csr';

const p256 = await generateKeyPair('P-256');
const rsa = await generateKeyPair('RSA-2048');

/** What a request holds, read back with the spec reader only. */
function parse(der: Uint8Array) {
	const request = readDer(der);
	expect(request.tag).toBe(0x30);
	expect(request.children).toHaveLength(3);
	const info = child(request, 0);
	const algorithm = child(request, 1);
	const signature = child(request, 2);
	expect(info.children).toHaveLength(4);
	expect(readInteger(child(info, 0))).toBe(0n);
	const subject = child(info, 1);
	const spki = child(info, 2);
	const attributes = child(info, 3);
	expect(attributes.tag).toBe(0xa0);
	expect(attributes.children).toHaveLength(1);
	const attribute = child(attributes, 0);
	expect(readOid(child(attribute, 0))).toBe(OID.extensionRequest);
	const values = child(attribute, 1);
	expect(values.tag).toBe(0x31);
	expect(values.children).toHaveLength(1);
	const extensions = child(values, 0);
	expect(extensions.children).toHaveLength(1);
	const extension = child(extensions, 0);
	expect(extension.children).toHaveLength(2);
	expect(readOid(child(extension, 0))).toBe(OID.subjectAltName);
	const wrapped = child(extension, 1);
	expect(wrapped.tag).toBe(0x04);
	const generalNames = readDer(wrapped.content);
	expect(generalNames.tag).toBe(0x30);
	const names = generalNames.children.map((name: DerNode) => {
		expect(name.tag).toBe(0x82);
		return readText(name);
	});
	expect(signature.tag).toBe(0x03);
	expect(signature.content[0]).toBe(0);
	return {
		info,
		subject,
		spki,
		names,
		algorithm,
		signature: signature.content.subarray(1),
	};
}

function commonNames(subject: DerNode): string[] {
	return subject.children.flatMap((rdn) =>
		rdn.children
			.filter((atv) => readOid(child(atv, 0)) === OID.commonName)
			.map((atv) => {
				expect(child(atv, 1).tag).toBe(0x0c);
				return readText(child(atv, 1));
			}),
	);
}

describe('createCsr (RFC 2986)', () => {
	for (const [label, keyPair] of [
		['P-256', p256],
		['RSA-2048', rsa],
	] as const) {
		test(`${label}: structure, OIDs, SAN and signature`, async () => {
			const csr = await createCsr({
				names: ['Example.com', 'www.example.com', 'mail.example.com'],
				keyPair,
			});
			expect(csr.names).toEqual([
				'example.com',
				'www.example.com',
				'mail.example.com',
			]);
			const read = parse(csr.der);
			expect(commonNames(read.subject)).toEqual(['example.com']);
			expect(read.names).toEqual(csr.names);
			const spki = new Uint8Array(
				await crypto.subtle.exportKey('spki', keyPair.publicKey),
			);
			expect(read.spki.raw).toEqual(spki);

			const algorithm = readOid(child(read.algorithm, 0));
			let verified: boolean;
			if (label === 'P-256') {
				expect(algorithm).toBe(OID.ecdsaWithSha256);
				expect(read.algorithm.children).toHaveLength(1);
				verified = await crypto.subtle.verify(
					{ name: 'ECDSA', hash: 'SHA-256' },
					keyPair.publicKey,
					derToP1363(read.signature) as BufferSource,
					read.info.raw as BufferSource,
				);
			} else {
				expect(algorithm).toBe(OID.sha256WithRsaEncryption);
				expect(child(read.algorithm, 1).raw).toEqual(Uint8Array.of(5, 0));
				verified = await crypto.subtle.verify(
					{ name: 'RSASSA-PKCS1-v1_5' },
					keyPair.publicKey,
					read.signature as BufferSource,
					read.info.raw as BufferSource,
				);
			}
			expect(verified).toBe(true);

			// node:crypto reads the DER ECDSA signature itself: a second implementation.
			const key = createPublicKey({
				key: Buffer.from(spki),
				format: 'der',
				type: 'spki',
			});
			expect(
				nodeVerify(
					'sha256',
					read.info.raw,
					{ key, dsaEncoding: 'der' },
					read.signature,
				),
			).toBe(true);
		});
	}

	test('PEM: the DER as base64 in lines of 64, labelled', async () => {
		const csr = await createCsr({ names: ['example.com'], keyPair: p256 });
		const lines = csr.pem.trimEnd().split('\n');
		expect(lines[0]).toBe('-----BEGIN CERTIFICATE REQUEST-----');
		expect(lines.at(-1)).toBe('-----END CERTIFICATE REQUEST-----');
		const body = lines.slice(1, -1);
		for (const line of body.slice(0, -1)) expect(line).toHaveLength(64);
		expect(Buffer.from(body.join(''), 'base64')).toEqual(Buffer.from(csr.der));
		expect(csr.pem.endsWith('\n')).toBe(true);
	});

	test('a first name longer than 64 characters leaves the subject empty; the SAN holds it', async () => {
		const long = `${'a'.repeat(60)}.example.com`;
		const csr = await createCsr({
			names: [long, 'example.com'],
			keyPair: p256,
		});
		const read = parse(csr.der);
		expect(read.subject.raw).toEqual(Uint8Array.of(0x30, 0));
		expect(read.names).toEqual([long, 'example.com']);
	});

	test('64 characters still make the CN', async () => {
		const name = `${'a'.repeat(52)}.example.com`;
		expect(name).toHaveLength(64);
		const csr = await createCsr({ names: [name], keyPair: p256 });
		expect(commonNames(parse(csr.der).subject)).toEqual([name]);
	});

	test('a request of 100 names, over 128 bytes of content everywhere', async () => {
		const names = Array.from(
			{ length: 100 },
			(_, i) => `host-${i}.example.org`,
		);
		const csr = await createCsr({ names, keyPair: rsa });
		expect(parse(csr.der).names).toEqual(names);
	});

	test('a key it cannot sign with is INVALID_KEY', async () => {
		const p384 = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-384' },
			true,
			['sign', 'verify'],
		);
		await expect(
			createCsr({ names: ['example.com'], keyPair: p384 }),
		).rejects.toThrow(
			new AcmeError(
				'INVALID_KEY',
				'createCsr(): keyPair.privateKey is ECDSA P-384; only ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 are supported',
			),
		);
		await expect(
			createCsr({
				names: ['example.com'],
				keyPair: { publicKey: p256.privateKey, privateKey: p256.privateKey },
			}),
		).rejects.toThrow(
			'createCsr(): keyPair.publicKey must be a public key, not a private one',
		);
		await expect(
			createCsr({
				names: ['example.com'],
				keyPair: { publicKey: rsa.publicKey, privateKey: p256.privateKey },
			}),
		).rejects.toThrow(
			"createCsr(): keyPair's public and private keys are not of the same algorithm",
		);
		await expect(
			createCsr({ names: ['example.com'], keyPair: undefined as never }),
		).rejects.toThrow(
			'createCsr(): keyPair must be a CryptoKeyPair ({ publicKey, privateKey })',
		);
		await expect(createCsr(undefined as never)).rejects.toThrow(
			'createCsr(): options must be an object',
		);
	});

	test('the names are checked before the key', async () => {
		await expect(
			createCsr({ names: ['*.example.com'], keyPair: undefined as never }),
		).rejects.toMatchObject({ code: 'INVALID_NAME' });
	});
});

describe.skipIf(!OPENSSL)('createCsr, read by openssl', () => {
	for (const [label, keyPair] of [
		['P-256', p256],
		['RSA-2048', rsa],
	] as const) {
		test(`${label}: openssl req -verify accepts it, and reads the subject and SAN`, async () => {
			const csr = await createCsr({
				names: ['example.com', 'www.example.com'],
				keyPair,
			});
			const verified = await openssl(
				['req', '-in', '{csr.pem}', '-noout', '-verify'],
				{ 'csr.pem': csr.pem },
			);
			expect(verified.exitCode).toBe(0);
			expect(`${verified.stdout}${verified.stderr}`).toMatch(
				/verify OK|Certificate request self-signature verify OK/,
			);
			const text = await openssl(
				['req', '-in', '{csr.pem}', '-noout', '-text'],
				{
					'csr.pem': csr.pem,
				},
			);
			expect(text.exitCode).toBe(0);
			expect(text.stdout).toMatch(/Subject: ?CN ?= ?example\.com/);
			expect(text.stdout).toContain('DNS:example.com, DNS:www.example.com');
			expect(text.stdout).toContain(
				label === 'P-256' ? 'ecdsa-with-SHA256' : 'sha256WithRSAEncryption',
			);
		});
	}

	test('a tampered request fails openssl req -verify', async () => {
		const csr = await createCsr({ names: ['example.com'], keyPair: p256 });
		const der = Uint8Array.from(csr.der);
		const at = Buffer.from(der).indexOf(Buffer.from('example.com'));
		der[at] = 'f'.charCodeAt(0);
		const result = await openssl(
			['req', '-in', '{csr.pem}', '-noout', '-verify'],
			{ 'csr.pem': pem('CERTIFICATE REQUEST', der) },
		);
		// LibreSSL exits 0 even so: the words are what both print.
		expect(`${result.stdout}${result.stderr}`).toMatch(/verify failure/);
		expect(`${result.stdout}${result.stderr}`).not.toMatch(/verify OK/);
	});
});
