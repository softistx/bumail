import { describe, expect, test } from 'bun:test';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { connect } from 'node:tls';
import { AcmeError } from '../errors';
import { OPENSSL, openssl } from '../openssl.fixtures';
import { exportPrivateKeyPem, generateKeyPair, importKeyPairPem } from './keys';
import { selfSignedCertificate } from './x509.fixtures';

const pairs = {
	'P-256': await generateKeyPair('P-256'),
	'RSA-2048': await generateKeyPair('RSA-2048'),
} as const;

/** Starts a TLS listener on Bun with that key and certificate, and completes one handshake against it. */
async function handshake(key: string, cert: string): Promise<boolean> {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		tls: { key, cert },
		socket: {
			open(socket) {
				socket.end('hello');
			},
			data() {},
		},
	});
	try {
		return await new Promise<boolean>((resolve, reject) => {
			const socket = connect({
				host: '127.0.0.1',
				port: listener.port,
				servername: 'test.example',
				ca: cert,
			});
			socket.once('secureConnect', () => {
				resolve(socket.authorized);
				socket.destroy();
			});
			socket.once('error', reject);
		});
	} finally {
		listener.stop(true);
	}
}

describe('generateKeyPair', () => {
	test('P-256 by default, RSA-2048 on request, extractable', async () => {
		const ec = await generateKeyPair();
		expect(ec.privateKey.algorithm).toMatchObject({
			name: 'ECDSA',
			namedCurve: 'P-256',
		});
		expect(ec.privateKey.extractable).toBe(true);
		expect(pairs['RSA-2048'].privateKey.algorithm).toMatchObject({
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			hash: { name: 'SHA-256' },
		});
	});

	test('another type is INVALID_OPTION', async () => {
		await expect(generateKeyPair('P-384' as never)).rejects.toThrow(
			new AcmeError(
				'INVALID_OPTION',
				`generateKeyPair(): the type is 'P-256' or 'RSA-2048', not "P-384"`,
			),
		);
	});
});

for (const [type, keyPair] of Object.entries(pairs)) {
	describe(`exportPrivateKeyPem, ${type}`, () => {
		test('PKCS #8 PEM that node:crypto parses as the same key', async () => {
			const text = await exportPrivateKeyPem(keyPair.privateKey);
			expect(text).toStartWith('-----BEGIN PRIVATE KEY-----\n');
			expect(text).toEndWith('-----END PRIVATE KEY-----\n');
			const parsed = createPrivateKey(text);
			expect(parsed.asymmetricKeyType).toBe(type === 'P-256' ? 'ec' : 'rsa');
			const spki = new Uint8Array(
				await crypto.subtle.exportKey('spki', keyPair.publicKey),
			);
			expect(
				new Uint8Array(
					createPublicKey(parsed).export({ type: 'spki', format: 'der' }),
				),
			).toEqual(spki);
		});

		test("Bun's TLS takes it as a listener's key", async () => {
			const key = await exportPrivateKeyPem(keyPair.privateKey);
			const cert = await selfSignedCertificate(keyPair, 'test.example');
			expect(await handshake(key, cert)).toBe(true);
		});

		test('importKeyPairPem reads it back: same public key, signatures that verify', async () => {
			const text = await exportPrivateKeyPem(keyPair.privateKey);
			const imported = await importKeyPairPem(text);
			expect(imported.privateKey.extractable).toBe(false);
			expect(
				new Uint8Array(
					await crypto.subtle.exportKey('spki', imported.publicKey),
				),
			).toEqual(
				new Uint8Array(
					await crypto.subtle.exportKey('spki', keyPair.publicKey),
				),
			);
			const params =
				type === 'P-256'
					? { name: 'ECDSA', hash: 'SHA-256' }
					: { name: 'RSASSA-PKCS1-v1_5' };
			const data = new TextEncoder().encode('data');
			const signature = await crypto.subtle.sign(
				params,
				imported.privateKey,
				data,
			);
			expect(
				await crypto.subtle.verify(params, keyPair.publicKey, signature, data),
			).toBe(true);
			const again = await importKeyPairPem(text, { extractable: true });
			expect(await exportPrivateKeyPem(again.privateKey)).toBe(text);
		});
	});
}

describe('exportPrivateKeyPem and importKeyPairPem refuse', () => {
	test('a key that is not extractable, or not private', async () => {
		const pair = await importKeyPairPem(
			await exportPrivateKeyPem(pairs['P-256'].privateKey),
		);
		await expect(exportPrivateKeyPem(pair.privateKey)).rejects.toThrow(
			new AcmeError(
				'INVALID_KEY',
				'exportPrivateKeyPem(): the key is not extractable; generate or import it with extractable: true',
			),
		);
		await expect(exportPrivateKeyPem(pairs['P-256'].publicKey)).rejects.toThrow(
			'exportPrivateKeyPem(): the key must be a private key, not a public one',
		);
		await expect(exportPrivateKeyPem('key' as never)).rejects.toThrow(
			'exportPrivateKeyPem(): the key must be a CryptoKey',
		);
	});

	test('text that holds no PKCS #8 key, or another key', async () => {
		await expect(importKeyPairPem('nothing')).rejects.toThrow(
			new AcmeError(
				'INVALID_KEY',
				'importKeyPairPem(): expected a PEM PRIVATE KEY block (PKCS #8)',
			),
		);
		await expect(importKeyPairPem(42 as never)).rejects.toThrow(
			'importKeyPairPem(): the PEM must be a string',
		);
		const p384 = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-384' },
			true,
			['sign'],
		);
		const der = new Uint8Array(
			await crypto.subtle.exportKey('pkcs8', p384.privateKey),
		);
		const text = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;
		await expect(importKeyPairPem(text)).rejects.toThrow(
			'importKeyPairPem(): the PRIVATE KEY is neither an ECDSA P-256 nor an RSA key',
		);
		await expect(
			importKeyPairPem(await exportPrivateKeyPem(pairs['P-256'].privateKey), {
				extractable: 'yes' as never,
			}),
		).rejects.toThrow('importKeyPairPem(): extractable must be a boolean');
	});

	test('an RSA key under 2048 bits', async () => {
		const small = await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				hash: 'SHA-256',
				modulusLength: 1024,
				publicExponent: Uint8Array.of(1, 0, 1),
			},
			true,
			['sign', 'verify'],
		);
		await expect(exportPrivateKeyPem(small.privateKey)).rejects.toThrow(
			'exportPrivateKeyPem(): the key is an RSA key of 1024 bits; at least 2048 are needed',
		);
	});
});

describe.skipIf(!OPENSSL)('exportPrivateKeyPem, read by openssl', () => {
	for (const [type, keyPair] of Object.entries(pairs)) {
		test(`${type}: openssl pkey reads it, and its public key is ours`, async () => {
			const key = await exportPrivateKeyPem(keyPair.privateKey);
			const result = await openssl(
				['pkey', '-in', '{key.pem}', '-pubout', '-outform', 'DER'],
				{ 'key.pem': key },
			);
			expect(result.exitCode).toBe(0);
			const spki = Buffer.from(
				await crypto.subtle.exportKey('spki', keyPair.publicKey),
			).toString('base64');
			const printed = await openssl(['pkey', '-in', '{key.pem}', '-pubout'], {
				'key.pem': key,
			});
			expect(printed.stdout.replace(/-----[^-]+-----|\s/g, '')).toBe(spki);
		});

		test(`${type}: openssl verifies the self-signed certificate of the spec fixture`, async () => {
			const cert = await selfSignedCertificate(keyPair, 'test.example');
			const result = await openssl(
				['verify', '-CAfile', '{cert.pem}', '{cert.pem}'],
				{ 'cert.pem': cert },
			);
			expect(result.stdout).toContain(': OK');
		});
	}
});
