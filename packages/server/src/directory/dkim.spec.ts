import { afterEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { importDkimPrivateKey, signDkim, verifyDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import { Directory } from './directory';
import { seededDirectory } from './directory.fixtures';

const opened: Directory[] = [];
afterEach(() => {
	for (const directory of opened.splice(0)) directory.close();
});

async function directory(): Promise<Directory> {
	const opening = await seededDirectory();
	opened.push(opening);
	return opening;
}

/** The `ServerError` `fn` throws, as `CODE: message`. */
async function failure(fn: () => unknown): Promise<string> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof ServerError) return `${error.code}: ${error.message}`;
		throw error;
	}
	throw new Error('it did not throw');
}

const MESSAGE =
	'From: <alice@example.com>\r\nTo: <joe@example.org>\r\nSubject: hi\r\n\r\nHello.\r\n';

describe('the DKIM keys', () => {
	test('generate makes an RSA-2048 key whose record verifies what it signs', async () => {
		const d = await directory();
		const key = await d.dkim.generate('Example.COM');
		expect(key).toMatchObject({
			domain: 'example.com',
			selector: 'bumail',
			name: 'bumail._domainkey.example.com',
		});
		expect(key.record).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);
		// A 2048-bit SubjectPublicKeyInfo is 294 bytes: 392 in base64.
		expect(key.record.length - 'v=DKIM1; k=rsa; p='.length).toBe(392);
		const signing = d.dkim.signingKey('example.com');
		expect(signing?.privateKey).toStartWith('-----BEGIN PRIVATE KEY-----\n');
		const signature = await signDkim(MESSAGE, {
			domain: 'example.com',
			selector: 'bumail',
			privateKey: await importDkimPrivateKey(signing?.privateKey ?? ''),
		});
		const [result] = await verifyDkim(signature + MESSAGE, {
			resolver: fixtureResolver({ [key.name]: { txt: [key.record] } }),
		});
		expect(result?.result).toBe('pass');
	});

	test('keeps the key in the directory file, its owner alone reading it', async () => {
		const file = join(tempDir(), 'directory.sqlite');
		const d = Directory.open({ file });
		opened.push(d);
		d.domains.add('example.com');
		await d.dkim.generate('example.com', { selector: 's1' });
		for (const path of [file, `${file}-wal`]) {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		const again = Directory.open({ file });
		opened.push(again);
		expect(again.dkim.signingKey('example.com')?.selector).toBe('s1');
	});

	test('lists, shows and removes keys, never handing out the private half', async () => {
		const d = await directory();
		await d.dkim.generate('example.com', { selector: 'Mail.2026' });
		expect(d.dkim.list().map((k) => [k.domain, k.selector])).toEqual([
			['example.com', 'mail.2026'],
		]);
		expect(JSON.stringify(d.dkim.list())).not.toContain('PRIVATE');
		expect(d.dkim.get('EXAMPLE.com')?.selector).toBe('mail.2026');
		expect(d.dkim.remove('example.com')).toBe('example.com');
		expect(d.dkim.get('example.com')).toBeUndefined();
		expect(d.dkim.signingKey('example.com')).toBeUndefined();
		expect(await failure(() => d.dkim.remove('example.com'))).toBe(
			'NOT_FOUND: the domain example.com has no DKIM key',
		);
	});

	test('refuses a second key unless replaced, a domain not hosted, a bad selector', async () => {
		const d = await directory();
		const first = await d.dkim.generate('example.com');
		expect(await failure(() => d.dkim.generate('example.com'))).toBe(
			'ALREADY_EXISTS: the domain example.com has a DKIM key already; --replace makes a new one',
		);
		const second = await d.dkim.generate('example.com', {
			selector: 'next',
			replace: true,
		});
		expect(second.selector).toBe('next');
		expect(second.record).not.toBe(first.record);
		expect(await failure(() => d.dkim.generate('example.org'))).toBe(
			'NOT_FOUND: the domain example.org is not hosted here; add it first',
		);
		for (const selector of ['', 'a b', '-x', 'x_y', 'é']) {
			expect(
				await failure(() =>
					d.dkim.generate('example.com', { selector, replace: true }),
				),
			).toBe(
				'INVALID: the selector must be a DNS name: letters, digits, hyphens and dots',
			);
		}
	});

	test('goes with its domain', async () => {
		const d = await directory();
		d.domains.add('example.net');
		await d.dkim.generate('example.net');
		d.domains.remove('example.net');
		expect(d.dkim.list()).toEqual([]);
	});
});
