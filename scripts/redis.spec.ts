import { describe, expect, test } from 'bun:test';
import { CONTAINER, IMAGE, portOf, runArgs, urlOf } from './redis';

describe('redis', () => {
	test('the port defaults to 56380 and must be one', () => {
		expect(portOf(undefined)).toBe(56380);
		expect(portOf('6380')).toBe(6380);
		expect(() => portOf('x')).toThrow(
			'BUMAIL_TEST_REDIS_PORT must be a port, not x',
		);
	});

	test('the container is redis:7, published on loopback only, and the URL points at it', () => {
		const args = runArgs(6380);
		expect(args).toContain(IMAGE);
		expect(args).toContain(CONTAINER);
		expect(args).toContain('127.0.0.1:6380:6379');
		expect(urlOf(6380)).toBe('redis://127.0.0.1:6380');
	});
});
