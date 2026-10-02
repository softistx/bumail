import { describe, expect, test } from 'bun:test';
import { parseCommand, parsePathCommand } from './command';

describe('parseCommand', () => {
	test('the verb is case-insensitive (RFC 5321 §2.4)', () => {
		expect(parseCommand('ehlo bar.com')).toEqual({
			verb: 'EHLO',
			argument: 'bar.com',
		});
		expect(parseCommand('QUIT')).toEqual({ verb: 'QUIT', argument: '' });
	});
});

describe('parsePathCommand', () => {
	test('MAIL FROM with ESMTP parameters (RFC 1870 §6, RFC 6152 §2)', () => {
		expect(
			parsePathCommand(
				'FROM:<Smith@bar.com> SIZE=500000 BODY=8BITMIME',
				'FROM',
			),
		).toEqual({
			path: { address: 'Smith@bar.com', local: 'Smith', domain: 'bar.com' },
			parameters: { SIZE: '500000', BODY: '8BITMIME' },
		});
	});

	test('a parameter with no value (RFC 6531 §3.4 SMTPUTF8)', () => {
		expect(
			parsePathCommand('FROM:<a@b.c> SMTPUTF8', 'FROM')?.parameters,
		).toEqual({ SMTPUTF8: '' });
	});

	test('a space after the colon is tolerated', () => {
		expect(parsePathCommand('TO: <Jones@foo.com>', 'TO')?.path.address).toBe(
			'Jones@foo.com',
		);
	});

	test('the null reverse-path only for FROM', () => {
		expect(parsePathCommand('FROM:<>', 'FROM')?.path.address).toBe('');
		expect(parsePathCommand('TO:<>', 'TO')).toBeUndefined();
	});

	test('wrong keyword, missing brackets or a bad parameter name', () => {
		expect(parsePathCommand('TO:<a@b.c>', 'FROM')).toBeUndefined();
		expect(parsePathCommand('FROM:a@b.c', 'FROM')).toBeUndefined();
		expect(parsePathCommand('FROM:<a@b.c> =x', 'FROM')).toBeUndefined();
	});
});
