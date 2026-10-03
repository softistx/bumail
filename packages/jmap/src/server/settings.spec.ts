import { describe, expect, test } from 'bun:test';
import { MemoryMailStore } from '@bumail/store';
import { JmapError } from '../errors';
import { jmap } from './jmap';
import type { JmapOptions } from './options';

const valid: JmapOptions = {
	store: new MemoryMailStore(),
	origin: 'https://mail.example.com',
	authenticate: () => null,
};

const refusal = (options: Partial<Record<keyof JmapOptions, unknown>>) => {
	try {
		jmap({ ...valid, ...options } as JmapOptions);
	} catch (error) {
		expect(error).toBeInstanceOf(JmapError);
		expect((error as JmapError).code).toBe('INVALID_OPTION');
		return (error as JmapError).message;
	}
	throw new Error('jmap() took the options');
};

describe('jmap() options', () => {
	test('takes the minimal options and returns an app with notify', () => {
		const server = jmap(valid);
		expect(typeof server.fetch).toBe('function');
		expect(() => server.notify('a')).not.toThrow();
	});

	test('refuses a store, authenticate, origin or basePath that cannot work', () => {
		expect(refusal({ store: {} })).toBe(
			'jmap(): store must be a MailStore, such as new MemoryMailStore()',
		);
		expect(refusal({ authenticate: undefined })).toBe(
			'jmap(): authenticate must be a function: it is how clients log in',
		);
		expect(refusal({ origin: 'mail.example.com' })).toStartWith(
			'jmap(): origin must be an http: or https: origin',
		);
		expect(refusal({ origin: 'https://mail.example.com/jmap' })).toStartWith(
			'jmap(): origin must be',
		);
		expect(refusal({ basePath: 'jmap/' })).toStartWith(
			'jmap(): basePath must be a path such as /jmap',
		);
		expect(refusal({ onError: 'log' })).toBe(
			'jmap(): onError must be a function',
		);
	});

	test('validates every limit and refuses an unknown one', () => {
		expect(refusal({ limits: { maxCallsInRequest: 0 } })).toBe(
			'jmap(): limits.maxCallsInRequest must be a positive integer, not 0',
		);
		expect(refusal({ limits: { maxSizeRequest: 1.5 } })).toBe(
			'jmap(): limits.maxSizeRequest must be a positive integer, not 1.5',
		);
		expect(refusal({ limits: { uploadTtl: 3_000_000 } })).toBe(
			'jmap(): limits.uploadTtl must be at most 2147483, not 3000000',
		);
		expect(refusal({ limits: { maxFoo: 1 } })).toBe(
			'jmap(): limits.maxFoo is not a limit',
		);
		expect(refusal({ hookTimeout: -1 })).toBe(
			'jmap(): hookTimeout must be a positive integer, not -1',
		);
	});
});
