import { describe, expect, test } from 'bun:test';
import {
	decodeLoginStep,
	decodePlain,
	encodeLoginStep,
	encodePlain,
} from './sasl';

const b64 = (text: string) => new TextEncoder().encode(text).toBase64();

describe('decodePlain (RFC 4616)', () => {
	test('§4 example: "\\0tim\\0tanstaaftanstaaf"', () => {
		expect(decodePlain('AHRpbQB0YW5zdGFhZnRhbnN0YWFm')).toEqual({
			mechanism: 'PLAIN',
			username: 'tim',
			password: 'tanstaaftanstaaf',
		});
	});

	test('§4 example with an authorization identity: "Ursel\\0Kurt\\0xipj3plmq"', () => {
		expect(decodePlain('VXJzZWwAS3VydAB4aXBqM3BsbXE=')).toEqual({
			mechanism: 'PLAIN',
			username: 'Kurt',
			password: 'xipj3plmq',
			authorizationId: 'Ursel',
		});
	});

	test('UTF-8 credentials', () => {
		expect(decodePlain(b64('\0jörg\0pässwörd'))?.username).toBe('jörg');
	});

	test('what is not a PLAIN response', () => {
		for (const response of [
			'',
			'!!!!',
			b64('tim\0pw'),
			b64('\0\0pw'),
			b64('\0tim\0'),
			b64('\0a\0b\0c'),
			'AHRpbQB0YW5',
		]) {
			expect(decodePlain(response)).toBeUndefined();
		}
		expect(
			decodePlain(new Uint8Array([0, 0xff, 0, 0x61]).toBase64()),
		).toBeUndefined();
	});
});

describe('decodeLoginStep', () => {
	test('one base64 line to its text', () => {
		expect(decodeLoginStep('dGlt')).toBe('tim');
		expect(decodeLoginStep('not base64')).toBeUndefined();
	});
});

describe('encodePlain and encodeLoginStep, the client side', () => {
	test('§4 example, without an authorization identity, read back by decodePlain', () => {
		expect(encodePlain('tim', 'tanstaaftanstaaf')).toBe(
			'AHRpbQB0YW5zdGFhZnRhbnN0YWFm',
		);
		expect(decodePlain(encodePlain('zoë', 'pässword'))).toEqual({
			mechanism: 'PLAIN',
			username: 'zoë',
			password: 'pässword',
		});
		expect(decodeLoginStep(encodeLoginStep('zoë'))).toBe('zoë');
	});
});
