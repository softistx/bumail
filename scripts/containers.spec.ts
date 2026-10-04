import { describe, expect, test } from 'bun:test';
import { containerOf, portFrom } from './containers';

describe('containers', () => {
	test('the port defaults to the fallback and must be one, the variable named', () => {
		expect(portFrom('PORT_VAR', undefined, 55432)).toBe(55432);
		expect(portFrom('PORT_VAR', '5433', 55432)).toBe(5433);
		expect(() => portFrom('PORT_VAR', '0', 1)).toThrow(
			'PORT_VAR must be a port, not 0',
		);
		expect(() => portFrom('PORT_VAR', 'x', 1)).toThrow(
			'PORT_VAR must be a port, not x',
		);
	});

	test('reads whether the container runs, and on which port', () => {
		expect(containerOf('true 55432\n')).toEqual({ running: true, port: 55432 });
		expect(containerOf('false 5433')).toEqual({ running: false, port: 5433 });
		expect(containerOf('false ')).toEqual({ running: false, port: 0 });
	});
});
