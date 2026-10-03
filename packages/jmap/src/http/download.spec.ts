import { afterEach, describe, expect, test } from 'bun:test';
import { type Harness, harness, SIMPLE } from '../server/app.fixtures';
import { disposition, nameOf } from './download';

describe('downloads', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('a name is cut at 255 code points, never inside a surrogate pair', async () => {
		expect(nameOf(`${'a'.repeat(254)}😀😀`)).toBe(`${'a'.repeat(254)}😀`);
		expect(nameOf('a\uD800b')).toBe('a�b');
		h = await harness();
		const message = await h.add(SIMPLE);
		const response = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}/${'a'.repeat(254)}%F0%9F%98%80%F0%9F%98%80`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toEndWith(
			`${'a'.repeat(254)}%F0%9F%98%80`,
		);
	});

	test('nosniff and a sandbox always; inline only for a type that runs nothing', async () => {
		h = await harness();
		const message = await h.add(SIMPLE);
		const url = `/jmap/download/${h.alice.id}/${message.blobId}/m`;
		const html = await h.fetch(`${url}?accept=text/html`);
		expect(html.headers.get('x-content-type-options')).toBe('nosniff');
		expect(html.headers.get('content-security-policy')).toBe(
			"default-src 'none'; sandbox",
		);
		expect(html.headers.get('content-disposition')).toStartWith('attachment;');
		const png = await h.fetch(`${url}?accept=image/png`);
		expect(png.headers.get('content-disposition')).toStartWith('inline;');
		expect(disposition('image/svg+xml', 'x.svg')).toStartWith('attachment;');
		expect(disposition('message/rfc822', 'x.eml')).toStartWith('attachment;');
	});
});
