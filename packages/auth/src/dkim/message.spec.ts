import { describe, expect, test } from 'bun:test';
import { streamOf } from './dkim.fixtures';
import { HeaderTooLarge, headerEnd, splitMessage } from './message';

async function bodyOf(body: AsyncIterable<Uint8Array>): Promise<string> {
	let text = '';
	for await (const chunk of body) text += new TextDecoder().decode(chunk);
	return text;
}

describe('headerEnd', () => {
	test('finds the blank line after CRLF or LF, and an empty header', () => {
		const at = (text: string) => headerEnd(new TextEncoder().encode(text), 0);
		expect(at('A: 1\r\n\r\nbody')).toEqual({ header: 6, body: 8 });
		expect(at('A: 1\n\nbody')).toEqual({ header: 5, body: 6 });
		expect(at('\r\nbody')).toEqual({ header: 0, body: 2 });
		expect(at('A: 1\r\n')).toBeUndefined();
	});
});

describe('splitMessage', () => {
	test('a stream in pieces of any size splits where the bytes do', async () => {
		const message = 'A: 1\r\nB: 2\r\n\r\nbody\r\n\r\nmore\r\n';
		for (let size = 1; size <= 9; size++) {
			const split = await splitMessage(streamOf(message, size), 1000);
			expect(split.header).toBe('A: 1\r\nB: 2\r\n');
			expect(await bodyOf(split.body)).toBe('body\r\n\r\nmore\r\n');
		}
	});

	test('keeps bytes as bytes in the header: one char each', async () => {
		const split = await splitMessage(
			new Uint8Array([0x41, 0x3a, 0xc3, 0xa9, 0x0a, 0x0a]),
			100,
		);
		expect(split.header).toBe('A:\u00c3\u00a9\n');
	});

	test('refuses a header past maxHeaderBytes, without reading the rest of a stream', async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new TextEncoder().encode('X-Long: aaaaaaaa\r\n'));
			},
		});
		await expect(splitMessage(endless, 100)).rejects.toBeInstanceOf(
			HeaderTooLarge,
		);
		await expect(splitMessage('A: 1\r\n\r\n', 3)).rejects.toBeInstanceOf(
			HeaderTooLarge,
		);
		await Bun.sleep(0);
		expect(pulled).toBeLessThan(20);
	});

	test('cancel stops a stream whose body is not wanted', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('A: 1\r\n\r\nbody'));
			},
			cancel() {
				cancelled = true;
			},
		});
		const split = await splitMessage(stream, 100);
		await split.cancel();
		expect(cancelled).toBe(true);
	});
});
