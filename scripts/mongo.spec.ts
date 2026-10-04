import { describe, expect, test } from 'bun:test';
import { CONTAINER, IMAGE, portOf, runArgs, urlOf } from './mongo';

describe('mongo', () => {
	test('the port defaults to 57017 and must be one', () => {
		expect(portOf(undefined)).toBe(57017);
		expect(portOf('27018')).toBe(27018);
		expect(() => portOf('70000')).toThrow(
			'BUMAIL_TEST_MONGO_PORT must be a port, not 70000',
		);
	});

	test('the container is mongo:7 with a root user, published on loopback only, and the URL points at it', () => {
		const args = runArgs(27018);
		expect(args).toContain(IMAGE);
		expect(args).toContain(CONTAINER);
		expect(args).toContain('127.0.0.1:27018:27017');
		expect(args).toContain('MONGO_INITDB_ROOT_USERNAME=root');
		expect(urlOf(27018)).toBe(
			'mongodb://root:bumail@127.0.0.1:27018/bumail_test?authSource=admin',
		);
	});
});
