import { describe, expect, test } from 'bun:test';
import { importDkimPrivateKey, signDkim } from '@bumail/auth';
import { fixtureResolver, type Resolver } from '@bumail/dns';
import { DKIM_TIMED_OUT, judge } from './inbound';
import { RECORDS } from './serve.fixtures';

/** The fixture DNS, except that a DKIM key lookup never answers. */
function slowDkim(): Resolver {
	const base = fixtureResolver(RECORDS);
	return {
		...base,
		txt: (name: string) =>
			name.includes('._domainkey.') ? new Promise(() => {}) : base.txt(name),
	};
}

/** A message signed for reject.example, whose key the DNS never gives. */
async function signed(): Promise<string> {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const pkcs8 = Buffer.from(
		await crypto.subtle.exportKey('pkcs8', pair.privateKey),
	).toString('base64');
	const privateKey = await importDkimPrivateKey(
		`-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
	);
	const text = 'From: <joe@reject.example>\r\nSubject: hi\r\n\r\nHello.\r\n';
	return (
		(await signDkim(text, {
			domain: 'reject.example',
			selector: 'slow',
			privateKey,
		})) + text
	);
}

test('a DKIM check past its deadline is a temperror, and enforce defers rather than refuses', async () => {
	const message = await signed();
	const bytes = new TextEncoder().encode(message);
	const header = bytes.subarray(0, message.indexOf('\r\n\r\n') + 2);
	const started = Date.now();
	const verdict = await judge(
		{ header, whole: () => new Blob([bytes]).stream() },
		undefined,
		{
			hostname: 'mail.example.com',
			resolver: slowDkim(),
			mode: 'enforce',
			timeoutMs: 100,
		},
	);
	expect(Date.now() - started).toBeGreaterThanOrEqual(90);
	expect(Date.now() - started).toBeLessThan(2000);
	expect(verdict.dkim).toEqual([DKIM_TIMED_OUT]);
	expect(verdict.dmarc.disposition).toBe('reject');
	expect(verdict.action).toBe('defer');
	expect(verdict.field).toContain('dkim=temperror');
});

describe('a message this server cannot read back', () => {
	/** Judges `message`, signed for reject.example (`p=reject`), with `whole` in place of its bytes. */
	async function judged(whole: () => ReadableStream<Uint8Array>) {
		const message = await signed();
		const bytes = new TextEncoder().encode(message);
		const header = bytes.subarray(0, message.indexOf('\r\n\r\n') + 2);
		return judge({ header, whole }, undefined, {
			hostname: 'mail.example.com',
			resolver: fixtureResolver(RECORDS),
			mode: 'enforce',
		});
	}

	test('whole() throwing is a DKIM temperror, and enforce defers rather than refuses', async () => {
		const verdict = await judged(() => {
			throw new Error('EBADF: bad file descriptor');
		});
		expect(verdict.dkim).toEqual([
			{
				result: 'temperror',
				reason: 'the message could not be read: EBADF: bad file descriptor',
				testing: false,
			},
		]);
		expect(verdict.dmarc.disposition).toBe('reject');
		expect(verdict.action).toBe('defer');
		expect(verdict.field).toContain('dkim=temperror');
	});

	test('a stream failing part way is a DKIM temperror, and enforce defers rather than refuses', async () => {
		const verdict = await judged(
			() =>
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(new Error('EIO: i/o error'));
					},
				}),
		);
		expect(verdict.dkim.map((d) => d.result)).toEqual(['temperror']);
		expect(verdict.dmarc.disposition).toBe('reject');
		expect(verdict.action).toBe('defer');
	});
});
