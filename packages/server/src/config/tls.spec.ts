import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { selfSigned } from './certificates.fixtures';
import { problemsOf, writeConfig } from './config.fixtures';
import { readConfig } from './read';

const FILES =
	'hostname = "mail.example.com"\n[tls]\nmode = "files"\ncert = "cert.pem"\nkey = "key.pem"\n';

describe('tls.mode = "files"', () => {
	test('takes a certificate for the hostname, with its key, relative to the file', async () => {
		const { cert, key } = await selfSigned(['mail.example.com']);
		const path = writeConfig(FILES, { 'cert.pem': cert, 'key.pem': key });
		const config = await readConfig({ path, env: {} });
		const dir = path.replace(/\/bumail\.toml$/, '');
		expect(config.tls).toEqual({
			mode: 'files',
			cert: join(dir, 'cert.pem'),
			key: join(dir, 'key.pem'),
			pollSeconds: 30,
		});
		expect(config.acme).toBeUndefined();
	});

	test('takes a wildcard that covers the hostname', async () => {
		const { cert, key } = await selfSigned(['*.example.com']);
		const path = writeConfig(FILES, { 'cert.pem': cert, 'key.pem': key });
		expect((await readConfig({ path, env: {} })).tls.mode).toBe('files');
	});

	test('refuses files that are not there', async () => {
		expect(await problemsOf(FILES)).toEqual([
			'tls.cert: cannot be read (ENOENT)',
			'tls.key: cannot be read (ENOENT)',
		]);
	});

	test('refuses files that are not PEM', async () => {
		const { cert, key } = await selfSigned(['mail.example.com']);
		expect(
			await problemsOf(FILES, { files: { 'cert.pem': key, 'key.pem': cert } }),
		).toEqual([
			'tls.cert: is not a PEM certificate',
			'tls.key: is not an unencrypted PEM private key',
		]);
		expect(
			await problemsOf(FILES, {
				files: {
					'cert.pem':
						'-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
					'key.pem':
						'-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n',
				},
			}),
		).toEqual([
			'tls.cert: is not a PEM certificate',
			'tls.key: is not an unencrypted PEM private key',
		]);
	});

	test('refuses a certificate for another name', async () => {
		const { cert, key } = await selfSigned(['mx.example.org', 'example.org']);
		expect(
			await problemsOf(FILES, { files: { 'cert.pem': cert, 'key.pem': key } }),
		).toEqual([
			'tls.cert: does not name mail.example.com (it names mx.example.org, example.org)',
		]);
	});

	test('refuses an expired certificate', async () => {
		const { cert, key } = await selfSigned(['mail.example.com'], {
			notBefore: new Date('2020-01-01T00:00:00Z'),
			notAfter: new Date('2021-01-01T00:00:00Z'),
		});
		expect(
			await problemsOf(FILES, { files: { 'cert.pem': cert, 'key.pem': key } }),
		).toEqual(['tls.cert: expired on 2021-01-01']);
	});

	test('refuses a key that is not the certificate’s, and never repeats it', async () => {
		const { cert } = await selfSigned(['mail.example.com']);
		const { key } = await selfSigned(['mail.example.com']);
		const problems = await problemsOf(FILES, {
			files: { 'cert.pem': cert, 'key.pem': key },
		});
		expect(problems).toEqual(['tls.key: is not the key of tls.cert']);
		const body = key.split('\n')[1] ?? '';
		expect(problems.join('\n')).not.toContain(body.slice(0, 20));
	});

	test('refuses a certificate not valid yet', async () => {
		const { cert, key } = await selfSigned(['mail.example.com'], {
			notBefore: new Date('2040-01-01T00:00:00Z'),
			notAfter: new Date('2041-01-01T00:00:00Z'),
		});
		expect(
			await problemsOf(FILES, { files: { 'cert.pem': cert, 'key.pem': key } }),
		).toEqual(['tls.cert: is not valid until 2040-01-01']);
	});

	test('refuses a certificate or key that is no regular file, or too large', async () => {
		const big = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(1024 * 1024)}\n`;
		const path = writeConfig(FILES.replace('key = "key.pem"', 'key = "."'), {
			'cert.pem': big,
		});
		await expect(readConfig({ path, env: {} })).rejects.toThrow(
			'  tls.cert: is larger than 1 MiB\n  tls.key: is not a regular file',
		);
	});

	test('names the CN when the certificate has no alternative names', async () => {
		const { cert, key } = await selfSigned([]);
		expect(
			await problemsOf(FILES, { files: { 'cert.pem': cert, 'key.pem': key } }),
		).toEqual([
			'tls.cert: does not name mail.example.com (it names localhost)',
		]);
	});
});

describe('tls.pollSeconds', () => {
	const WITH = (value: string) => `${FILES}pollSeconds = ${value}\n`;
	const files = async () => {
		const { cert, key } = await selfSigned(['mail.example.com']);
		return { 'cert.pem': cert, 'key.pem': key };
	};

	test('is how often the files are looked at: 30 s by default, 0 for never', async () => {
		for (const [value, expected] of [
			['5', 5],
			['0', 0],
			['86400', 86400],
		] as const) {
			const path = writeConfig(WITH(value), await files());
			expect((await readConfig({ path, env: {} })).tls).toMatchObject({
				pollSeconds: expected,
			});
		}
	});

	test('is an integer from 0 to a day', async () => {
		for (const value of ['-1', '86401', '1.5', '"30"']) {
			expect(await problemsOf(WITH(value), { files: await files() })).toEqual([
				'tls.pollSeconds: must be an integer from 0 to 86400',
			]);
		}
	});

	test('is for tls.mode "files" alone', async () => {
		const acme =
			'hostname = "mail.example.com"\n[tls]\npollSeconds = 30\n[acme]\nemail = "a@example.com"\nacceptTerms = true\n';
		expect(await problemsOf(acme)).toEqual([
			'tls.pollSeconds: is only for tls.mode "files"',
		]);
	});
});
