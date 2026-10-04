import { describe, expect, test } from 'bun:test';
import { lineState, take } from './secret';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('take, the hidden prompt’s keys', () => {
	test('reads a line to Enter, CR or LF', () => {
		for (const enter of ['\r', '\n', '\r\n']) {
			const state = lineState();
			expect(take(state, bytes(`secret${enter}`))).toEqual({
				kind: 'line',
				line: 'secret',
			});
		}
	});

	test('waits for more until Enter', () => {
		const state = lineState();
		expect(take(state, bytes('sec'))).toEqual({ kind: 'more' });
		expect(take(state, bytes('ret\r'))).toEqual({
			kind: 'line',
			line: 'secret',
		});
	});

	test('Backspace erases a character, DEL or BS, a whole one past ASCII', () => {
		const state = lineState();
		expect(take(state, bytes('abx\u007fcé\bè\r'))).toEqual({
			kind: 'line',
			line: 'abcè',
		});
		expect(take(lineState(), bytes('\u007f\u007fok\r'))).toEqual({
			kind: 'line',
			line: 'ok',
		});
	});

	test('Ctrl-C and Ctrl-D cancel', () => {
		for (const key of ['\u0003', '\u0004']) {
			const state = lineState();
			expect(take(state, bytes(`half${key}rest\r`))).toEqual({
				kind: 'cancel',
			});
			expect(state.text).toBe('');
		}
	});

	test('a character split across two reads is decoded whole', () => {
		const state = lineState();
		const euro = bytes('€');
		expect(take(state, euro.slice(0, 1))).toEqual({ kind: 'more' });
		expect(take(state, euro.slice(1, 2))).toEqual({ kind: 'more' });
		expect(take(state, new Uint8Array([...euro.slice(2), 13]))).toEqual({
			kind: 'line',
			line: '€',
		});
	});

	test('what follows Enter answers the next prompt, CR LF split across reads included', () => {
		const state = lineState();
		expect(take(state, bytes('first\r'))).toEqual({
			kind: 'line',
			line: 'first',
		});
		expect(take(state, bytes('\nsecond\r\nthird'))).toEqual({
			kind: 'line',
			line: 'second',
		});
		expect(take(state)).toEqual({ kind: 'more' });
		expect(take(state, bytes('\r'))).toEqual({ kind: 'line', line: 'third' });
		const pasted = lineState();
		expect(take(pasted, bytes('pw\rpw\r'))).toEqual({
			kind: 'line',
			line: 'pw',
		});
		expect(take(pasted)).toEqual({ kind: 'line', line: 'pw' });
	});
});
