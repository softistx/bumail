import { describe, expect, test } from 'bun:test';
import { fixtureResolver, type Resolver } from '@bumail/dns';
import type { MxResolver, SendMailOptions } from './options';

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

describe('SendMailOptions', () => {
	const resolver: MxResolver = {
		mx: async () => [],
		a: async () => [],
		aaaa: async () => [],
	};
	const envelope = { from: 'a@bar.com', to: 'b@foo.com' };

	test('by MX, helo is required by the type itself, not only at runtime', () => {
		const byMx: SendMailOptions = {
			...envelope,
			domain: 'foo.com',
			resolver,
			helo: 'mail.bar.com',
		};
		// @ts-expect-error delivery by MX needs helo, so `{ domain, resolver }` alone does not compile
		const withoutHelo: SendMailOptions = {
			...envelope,
			domain: 'foo.com',
			resolver,
		};
		expect(byMx.helo).toBe('mail.bar.com');
		expect(withoutHelo).not.toHaveProperty('helo');
	});

	test('to a host, helo stays optional', () => {
		const toHost: SendMailOptions = { ...envelope, host: 'smtp.bar.com' };
		expect(toHost).not.toHaveProperty('helo');
	});
});
