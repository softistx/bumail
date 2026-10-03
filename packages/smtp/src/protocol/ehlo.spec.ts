import { describe, expect, test } from 'bun:test';
import { parseEhlo } from './ehlo';

describe('parseEhlo (RFC 5321 §4.1.1.1)', () => {
	test('keywords in upper case, their parameters as written; the greeting line skipped', () => {
		const extensions = parseEhlo([
			'foo.com greets bar.com',
			'pipelining',
			'SIZE 10240000',
			'AUTH  PLAIN LOGIN ',
			'',
			'8BITMIME',
		]);
		expect([...extensions]).toEqual([
			['PIPELINING', ''],
			['SIZE', '10240000'],
			['AUTH', 'PLAIN LOGIN'],
			['8BITMIME', ''],
		]);
	});
});
