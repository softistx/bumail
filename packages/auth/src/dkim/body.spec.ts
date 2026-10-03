import { describe, expect, test } from 'bun:test';
import { BodyHasher } from './body';
import type { Canonicalization } from './canon';

async function sha(text: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
	);
}

/** Hashes `body` in pieces of `size`, and checks the result is the hash of `canonical`. */
async function expectCanonical(
	body: string,
	method: Canonicalization,
	canonical: string,
	size = body.length || 1,
) {
	const hasher = new BodyHasher(method);
	const bytes = new TextEncoder().encode(body);
	for (let at = 0; at < bytes.length; at += size)
		hasher.write(bytes.subarray(at, at + size));
	const digest = hasher.end();
	expect(digest.length).toBe(canonical.length);
	expect(digest.hash).toEqual(await sha(canonical));
}

describe('BodyHasher (RFC 6376 §3.4.3, §3.4.4)', () => {
	test('an empty body: simple is one CRLF, relaxed is nothing', async () => {
		await expectCanonical('', 'simple', '\r\n');
		await expectCanonical('', 'relaxed', '');
		await expectCanonical('\r\n\r\n', 'simple', '\r\n');
		await expectCanonical(' \t\r\n\r\n', 'relaxed', '');
	});

	test('adds the CRLF a last line is missing', async () => {
		await expectCanonical('end', 'simple', 'end\r\n');
		await expectCanonical('end  ', 'relaxed', 'end\r\n');
	});

	test('reads a bare LF as CRLF, and a CRLF/LF mix the same', async () => {
		const canonical = 'a\r\n\r\nb\r\n';
		for (const body of ['a\n\nb\n', 'a\r\n\nb\r\n', 'a\n\r\nb\n\n\n']) {
			await expectCanonical(body, 'simple', canonical);
			await expectCanonical(body, 'relaxed', canonical);
		}
	});

	test('a CR not before LF is content', async () => {
		await expectCanonical('a\rb\r\n', 'simple', 'a\rb\r\n');
		await expectCanonical('a\r', 'simple', 'a\r\r\n');
	});

	test('the same result in pieces of every size, CRLF cut in two included', async () => {
		const body = 'one \t two\r\n\r\n  three \r\n\r\n\r\nfour\r\n\r\n';
		for (let size = 1; size <= 8; size++) {
			await expectCanonical(
				body,
				'relaxed',
				'one two\r\n\r\n three\r\n\r\n\r\nfour\r\n',
				size,
			);
			await expectCanonical(
				body,
				'simple',
				'one \t two\r\n\r\n  three \r\n\r\n\r\nfour\r\n',
				size,
			);
		}
	});

	test('hashes only the first l= octets, and counts them all', async () => {
		const hasher = new BodyHasher('simple', 3);
		hasher.write(new TextEncoder().encode('abcdef\r\n'));
		const digest = hasher.end();
		expect(digest.length).toBe(8);
		expect(digest.hash).toEqual(await sha('abc'));
		const none = new BodyHasher('relaxed', 0);
		none.write(new TextEncoder().encode('anything\r\n'));
		expect(none.end().hash).toEqual(await sha(''));
	});

	test('a body larger than its buffer', async () => {
		const line = `${'x'.repeat(99)}\r\n`;
		await expectCanonical(line.repeat(2000), 'simple', line.repeat(2000), 7777);
	});
});
