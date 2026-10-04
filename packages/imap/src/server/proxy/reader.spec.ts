import { describe, expect, test } from 'bun:test';
import { MAX_TLV_BYTES } from './header';
import { concat, tlv, v1, v2 } from './headers.fixtures';
import { HeaderReader } from './reader';

function reader(seconds = 5) {
	const outcomes: string[] = [];
	const rests: Uint8Array[] = [];
	const read = new HeaderReader(
		seconds,
		(source, rest) => {
			outcomes.push(`done ${source}`);
			rests.push(rest);
		},
		() => outcomes.push('refused'),
	);
	return { read, outcomes, rests };
}

describe('HeaderReader', () => {
	test('a header in pieces, then what follows it handed on whole', () => {
		const { read, outcomes, rests } = reader();
		const bytes = concat(v2({ source: '198.51.100.7' }), 'EHLO x\r\n');
		read.receive(bytes.subarray(0, 3));
		read.receive(bytes.subarray(3, 20));
		expect(outcomes).toEqual([]);
		read.receive(bytes.subarray(20));
		expect(outcomes).toEqual(['done 198.51.100.7']);
		expect(new TextDecoder().decode(rests[0])).toBe('EHLO x\r\n');
		read.cancel();
	});

	test('LOCAL: done, with no source', () => {
		const { read, outcomes } = reader();
		read.receive(v2({ command: 0, family: 0 }));
		expect(outcomes).toEqual(['done undefined']);
	});

	test('refused once, and deaf after', () => {
		const { read, outcomes } = reader();
		read.receive(new TextEncoder().encode('GET / HTTP/1.1\r\n'));
		read.receive(v1('198.51.100.7'));
		expect(outcomes).toEqual(['refused']);
	});

	test('the longest header, however it is cut', () => {
		const { read, outcomes } = reader();
		const header = v2({
			source: '198.51.100.7',
			tlvs: [tlv(0xe0, new Uint8Array(MAX_TLV_BYTES - 3))],
		});
		for (let at = 0; at < header.length; at += 100) {
			read.receive(header.subarray(at, at + 100));
		}
		expect(outcomes).toEqual(['done 198.51.100.7']);
	});

	test('a header not complete within its time is refused, however it trickles', async () => {
		const { read, outcomes } = reader(0.2);
		const header = v1('198.51.100.7');
		for (let at = 0; at < 10; at++) {
			read.receive(header.subarray(at, at + 1));
			await Bun.sleep(30);
		}
		expect(outcomes).toEqual(['refused']);
		read.receive(header.subarray(10));
		expect(outcomes).toEqual(['refused']);
	});

	test('cancel: no timer left, nothing called', async () => {
		const { read, outcomes } = reader(0.05);
		read.receive(new TextEncoder().encode('PROXY '));
		read.cancel();
		await Bun.sleep(100);
		read.receive(v1('198.51.100.7'));
		expect(outcomes).toEqual([]);
	});
});
