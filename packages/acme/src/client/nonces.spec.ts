import { describe, expect, test } from 'bun:test';
import { MAX_NONCES, NoncePool } from './nonces';

describe('NoncePool', () => {
	test('gives the newest first, each once', () => {
		const pool = new NoncePool();
		pool.keep('a');
		pool.keep('b');
		expect(pool.take()).toBe('b');
		expect(pool.take()).toBe('a');
		expect(pool.take()).toBeUndefined();
	});

	test(`keeps ${MAX_NONCES} at most, dropping the oldest`, () => {
		const pool = new NoncePool();
		for (let i = 0; i < MAX_NONCES + 4; i++) pool.keep(`n${i}`);
		expect(pool.size).toBe(MAX_NONCES);
		const taken: string[] = [];
		for (let n = pool.take(); n !== undefined; n = pool.take()) taken.push(n);
		expect(taken.at(-1)).toBe('n4');
	});
});
