import { describe, expect, test } from 'bun:test';
import { MemoryMailStore } from '@bumail/store';
import { ImapError } from '../errors';
import { createImapServer } from './server';
import { FAKE_TLS, imapOptions } from './session.fixtures';

const store = new MemoryMailStore();
const base = imapOptions(store, 'account');

function refusal(options: object): string {
	try {
		createImapServer({ ...base, ...options });
	} catch (error) {
		expect(error).toBeInstanceOf(ImapError);
		expect((error as ImapError).code).toBe('INVALID_OPTION');
		return (error as Error).message;
	}
	throw new Error('accepted');
}

describe('createImapServer options', () => {
	test('the defaults are taken', () => {
		expect(() => createImapServer(base)).not.toThrow();
	});

	test('hostname, store, authenticate and tls are required', () => {
		expect(refusal({ hostname: 'not a host' })).toBe(
			'createImapServer(): "not a host" is not a host name',
		);
		expect(refusal({ store: {} })).toBe(
			'createImapServer(): store must be a MailStore, such as new MemoryMailStore()',
		);
		expect(refusal({ authenticate: undefined })).toBe(
			'createImapServer(): authenticate must be a function: it is how users log in',
		);
		expect(refusal({ tls: undefined })).toBe(
			'createImapServer(): tls: { key, cert } is required, since LOGIN is offered only once encrypted',
		);
		expect(refusal({ tls: { ...FAKE_TLS, key: '' } })).toContain(
			'tls: { key, cert } is required',
		);
	});

	test('timeout is 30 minutes at least (RFC 9051 §5.4), and fits a timer', () => {
		expect(refusal({ timeout: 60 })).toBe(
			'createImapServer(): timeout must be at least 1800 seconds (RFC 9051 §5.4), not 60',
		);
		expect(refusal({ timeout: 2_147_484 })).toBe(
			'createImapServer(): timeout must be at most 2147483, not 2147484',
		);
	});

	test('the limits are positive integers; the timers fit setTimeout', () => {
		expect(refusal({ maxConnections: 0 })).toBe(
			'createImapServer(): maxConnections must be a positive integer, not 0',
		);
		expect(refusal({ maxLiteralSize: 1.5 })).toContain(
			'maxLiteralSize must be a positive integer',
		);
		expect(refusal({ maxMessageSize: 2 ** 32 })).toBe(
			'createImapServer(): maxMessageSize must be at most 4294967295, not 4294967296',
		);
		expect(refusal({ hookTimeout: 3_000_000 })).toContain(
			'hookTimeout must be at most 2147483',
		);
		expect(refusal({ loginTimeout: 3_000_000 })).toContain(
			'loginTimeout must be at most 2147483',
		);
		expect(refusal({ idleInterval: 0 })).toBe(
			'createImapServer(): idleInterval must be a number of seconds, more than 0 and at most 2147483, not 0',
		);
	});
});
