import { describe, expect, test } from 'bun:test';
import { AcmeError } from '../errors';
import { checkName, checkNames, MAX_NAMES } from './names';

function refused(run: () => unknown, code: string, message: string): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AcmeError);
	expect((caught as AcmeError).code).toBe(code as AcmeError['code']);
	expect((caught as AcmeError).message).toBe(message);
}

describe('checkName', () => {
	test('a DNS name comes back lowercased', () => {
		expect(checkName('Mail.Example.COM')).toBe('mail.example.com');
		expect(checkName('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
		expect(checkName('a-b.c0.example')).toBe('a-b.c0.example');
		expect(checkName(`${'a'.repeat(63)}.example`)).toBe(
			`${'a'.repeat(63)}.example`,
		);
	});

	test('253 characters fit, 254 do not', () => {
		const label = 'a'.repeat(63);
		const name253 = [label, label, label, 'a'.repeat(61)].join('.');
		expect(name253.length).toBe(253);
		expect(checkName(name253)).toBe(name253);
		const name254 = `${name253}a`;
		refused(
			() => checkName(name254),
			'INVALID_NAME',
			`createCsr(): ${JSON.stringify(`${name254.slice(0, 80)}…`)} is longer than 253 characters`,
		);
	});

	test.each([
		[42, 'createCsr(): a name is a string, not number'],
		[null, 'createCsr(): a name is a string, not null'],
		[
			'bücher.example',
			'createCsr(): "bücher.example" is not ASCII; give an internationalized name as its A-labels (xn--…)',
		],
		[
			'a b.example',
			'createCsr(): "a b.example" holds a space or a control character',
		],
		[
			'*.example.com',
			'createCsr(): "*.example.com" is a wildcard name, which this package does not request',
		],
		[
			'example.com.',
			'createCsr(): "example.com." ends with a dot; give the name without it',
		],
		['a..example', 'createCsr(): "a..example" has an empty label'],
		['', 'createCsr(): "" has an empty label'],
		[
			`${'a'.repeat(64)}.example`,
			`createCsr(): "${'a'.repeat(64)}.example" has a label longer than 63 characters`,
		],
		[
			'-a.example',
			'createCsr(): "-a.example" has a label that is not letters, digits and inner hyphens: "-a"',
		],
		[
			'a_b.example',
			'createCsr(): "a_b.example" has a label that is not letters, digits and inner hyphens: "a_b"',
		],
		[
			'a.*.example',
			'createCsr(): "a.*.example" has a label that is not letters, digits and inner hyphens: "*"',
		],
		[
			'localhost',
			'createCsr(): "localhost" is a single label; a certificate name has at least two',
		],
		[
			'192.0.2.1',
			'createCsr(): "192.0.2.1" ends in a numeric label, as an IP address does; only DNS names are supported',
		],
	])('%p is refused', (name, message) => {
		refused(() => checkName(name), 'INVALID_NAME', message);
	});
});

describe('checkNames', () => {
	test('names keep their order, lowercased', () => {
		expect(checkNames(['www.Example.com', 'example.com'])).toEqual([
			'www.example.com',
			'example.com',
		]);
	});

	test(`at most ${MAX_NAMES} names`, () => {
		const names = Array.from({ length: MAX_NAMES }, (_, i) => `n${i}.example`);
		expect(checkNames(names)).toHaveLength(MAX_NAMES);
		refused(
			() => checkNames([...names, 'one-more.example']),
			'INVALID_OPTION',
			'createCsr(): names holds 101 names; at most 100 fit one certificate',
		);
	});

	test('no names, not an array, a duplicate', () => {
		refused(
			() => checkNames([]),
			'INVALID_OPTION',
			'createCsr(): names must hold at least one name',
		);
		refused(
			() => checkNames('example.com'),
			'INVALID_OPTION',
			'createCsr(): names must be an array of DNS names',
		);
		refused(
			() => checkNames(['example.com', 'EXAMPLE.com']),
			'INVALID_OPTION',
			'createCsr(): "example.com" is given twice',
		);
	});
});
