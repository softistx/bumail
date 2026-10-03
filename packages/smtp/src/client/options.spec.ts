import { describe, expect, test } from 'bun:test';
import { fixtureResolver, type Resolver } from '@bumail/dns';
import type { MxResolver } from './options';

describe('MxResolver, declared by shape (AGENTS.md, deliberate duplications)', () => {
	test('@bumail/dns’s Resolver is an MxResolver: typecheck fails otherwise', async () => {
		// The assignment is the assertion: `tsc` refuses it if the shapes drift.
		const fits = (resolver: Resolver): MxResolver => resolver;
		const resolver = fits(
			fixtureResolver({
				'foo.com': { mx: [{ exchange: 'mx.foo.com', priority: 10 }] },
				'mx.foo.com': { a: ['127.0.0.1'] },
			}),
		);
		expect(await resolver.mx('foo.com')).toMatchObject([
			{ exchange: 'mx.foo.com', priority: 10 },
		]);
		expect(await resolver.a('mx.foo.com')).toMatchObject([
			{ address: '127.0.0.1' },
		]);
	});
});
