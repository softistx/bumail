import { describe, expect, test } from 'bun:test';
import {
	CONTAINER,
	containerOf,
	IMAGE,
	portOf,
	runArgs,
	urlOf,
} from './postgres';

describe('postgres', () => {
	test('the port defaults to 55432 and must be one', () => {
		expect(portOf(undefined)).toBe(55432);
		expect(portOf('5433')).toBe(5433);
		expect(() => portOf('0')).toThrow('must be a port, not 0');
		expect(() => portOf('x')).toThrow('must be a port, not x');
	});

	test('the container is postgres:17, published on loopback only, and the URL points at it', () => {
		const args = runArgs(5433);
		expect(args).toContain(IMAGE);
		expect(args).toContain(CONTAINER);
		expect(args).toContain('127.0.0.1:5433:5432');
		expect(urlOf(5433)).toBe(
			'postgres://postgres:bumail@127.0.0.1:5433/bumail_test',
		);
	});

	test('reads whether the container runs, and on which port', () => {
		expect(containerOf('true 55432\n')).toEqual({ running: true, port: 55432 });
		expect(containerOf('false 5433')).toEqual({ running: false, port: 5433 });
		expect(containerOf('false ')).toEqual({ running: false, port: 0 });
	});
});
