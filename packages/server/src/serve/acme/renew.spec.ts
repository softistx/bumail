import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcmeError } from '@bumail/acme';
import { selfSigned } from '../../config/certificates.fixtures';
import { tempDir } from '../../config/config.fixtures';
import type { AcmeConfig } from '../../config/types';
import type { TlsWatch } from '../reload';
import type { TlsFiles } from '../tls';
import { createChallenge } from './challenge';
import { attempt, type RenewalContext, retryWait } from './renew';
import { type AcmeOptions, withDefaults } from './run';
import { AcmeState } from './state';

const config: AcmeConfig = {
	email: undefined,
	acceptTerms: true,
	directory: 'https://ca.example.invalid/dir',
	names: ['a.bumail.test'],
	dir: '/unused',
	renewBeforeDays: 30,
	bind: '0.0.0.0',
};

/** A context whose `issue` answers `next`, over a state holding `old`, and a watch that takes pairs only if `takes`. */
async function context(
	takes: boolean,
	issued: () => Promise<TlsFiles>,
	options: AcmeOptions = {},
) {
	const old = await selfSigned(['a.bumail.test']);
	const dir = tempDir();
	const state = new AcmeState(join(dir, 'acme'));
	mkdirSync(join(dir, 'acme'));
	state.writePair(old);
	const lines: string[] = [];
	let applied: TlsFiles = old;
	const watch: TlsWatch = {
		get applied() {
			return applied;
		},
		reload: async () => {
			const pair = state.readPair();
			if (takes && pair) applied = pair;
		},
		stop() {},
	};
	const told: TlsFiles[] = [];
	const ctx: RenewalContext = {
		run: {
			config,
			state,
			challenge: createChallenge({ hostname: 'a.bumail.test', log: () => {} }),
			log: (line) => lines.push(line),
			options: withDefaults(options),
		},
		watch,
		applied: (pair) => told.push(pair),
		abort: new AbortController(),
		failures: 0,
		asked: 0,
		timer: undefined,
		issue: issued,
	};
	return { ctx, state, old, lines, told, dir };
}

describe('a renewal', () => {
	test('applied: the new pair is on the volume, the old one kept as the previous, and it is told', async () => {
		const next = await selfSigned(['a.bumail.test']);
		const { ctx, state, old, lines, told } = await context(
			true,
			async () => next,
		);
		await attempt(ctx);
		expect(state.readPair()).toEqual(next);
		expect(state.readPrevious()).toEqual(old);
		expect(told).toEqual([next]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith('tls: renewed (a.bumail.test; expires ');
	});

	test('refused by a listener: the old pair is written back over the new one, and the failure is logged', async () => {
		const next = await selfSigned(['a.bumail.test']);
		const { ctx, state, old, lines, told } = await context(
			false,
			async () => next,
		);
		await attempt(ctx);
		expect(state.readPair()).toEqual(old);
		expect(told).toEqual([]);
		expect(lines).toEqual([
			'tls: renewal failed: the listeners did not take the new certificate; see the line above; the current certificate stays, trying again in 10 min',
		]);
		expect(ctx.failures).toBe(1);
	});

	test('a rate limit lengthens the next wait to its Retry-After, and a success forgets it', async () => {
		const failing = async (): Promise<TlsFiles> => {
			throw new AcmeError('RATE_LIMITED', 'too many', { retryAfter: 7200 });
		};
		const { ctx } = await context(true, failing);
		await attempt(ctx);
		expect(retryWait(ctx)).toBe(7_200_000);
		const next = await selfSigned(['a.bumail.test']);
		const again = await context(true, async () => next);
		again.ctx.failures = 3;
		again.ctx.asked = 7_200_000;
		await attempt(again.ctx);
		expect(again.ctx.failures).toBe(0);
		expect(again.ctx.asked).toBe(0);
	});

	test('a failed attempt leaves the files as they were', async () => {
		const { ctx, state, old, dir } = await context(true, async () => {
			throw new Error('down');
		});
		writeFileSync(join(dir, 'untouched'), 'x');
		await attempt(ctx);
		expect(state.readPair()).toEqual(old);
		expect(readFileSync(join(dir, 'untouched'), 'utf8')).toBe('x');
	});
});
