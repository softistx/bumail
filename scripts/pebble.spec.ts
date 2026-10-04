import { describe, expect, test } from 'bun:test';
import {
	CONTAINER,
	caPath,
	IMAGE,
	PEBBLE_NAMES,
	portOf,
	runArgs,
	urlOf,
} from './pebble';

describe('pebble', () => {
	test('the port defaults to 14000 and must be one', () => {
		expect(portOf(undefined)).toBe(14000);
		expect(portOf('14001')).toBe(14001);
		expect(() => portOf('x')).toThrow(
			'BUMAIL_TEST_PEBBLE_PORT must be a port, not x',
		);
	});

	test('the container is a pinned Pebble, its API on loopback only, each name resolving to the host', () => {
		const args = runArgs(14001);
		expect(IMAGE).toMatch(/^ghcr\.io\/letsencrypt\/pebble:\d+\.\d+\.\d+$/);
		expect(args).toContain(IMAGE);
		expect(args).toContain(CONTAINER);
		expect(args).toContain('127.0.0.1:14001:14000');
		expect(args).toContain('PEBBLE_VA_NOSLEEP=1');
		for (const name of PEBBLE_NAMES) {
			expect(args).toContain(`${name}:host-gateway`);
		}
		expect(urlOf(14001)).toBe('https://localhost:14001/dir');
		expect(caPath()).toEndWith('bumail-pebble-ca.pem');
	});

	test("CI's Pebble and the specs' fixture name the same hosts", async () => {
		const ci = await Bun.file(
			`${import.meta.dir}/../.github/workflows/ci.yml`,
		).text();
		const fixture = await Bun.file(
			`${import.meta.dir}/../packages/acme/src/client/pebble.fixtures.ts`,
		).text();
		for (const name of PEBBLE_NAMES) {
			expect(ci).toContain(`--add-host ${name}:host-gateway`);
			expect(fixture).toContain(`'${name}'`);
		}
	});
});
