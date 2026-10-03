import { afterEach, describe, expect, test } from 'bun:test';
import { type Harness, harness } from '../server/app.fixtures';

const long = 'x'.repeat(10_000);

describe('ids and creation ids in /set and /get', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('an update key, a destroy item and a #creationId are [A-Za-z0-9_-]{1,255}, never echoed whole', async () => {
		h = await harness();
		const calls: [string, Record<string, unknown>][] = [
			['Email/set', { update: { [long]: { keywords: {} } } }],
			['Email/set', { update: { 'a b': { keywords: {} } } }],
			['Email/set', { destroy: [`${long}!`] }],
			['Email/set', { destroy: ['#'] }],
			['Mailbox/set', { update: { [`#${long}`]: { name: 'x' } } }],
			['Mailbox/set', { destroy: ['é'] }],
			['Email/get', { ids: [`#${long}`] }],
		];
		for (const [name, args] of calls) {
			const { args: answer } = await h.call(name, args);
			expect(answer.type).toBe('invalidArguments');
			expect(JSON.stringify(answer).length).toBeLessThan(300);
		}
		const { args } = await h.call('Email/set', {
			update: { [long.slice(0, 255)]: { keywords: {} } },
		});
		expect(args.notUpdated[long.slice(0, 255)].type).toBe('notFound');
	});

	test('an unknown #creationId of a valid syntax is not found', async () => {
		h = await harness();
		const { args } = await h.call('Email/set', { destroy: ['#k'] });
		expect(args.notDestroyed).toEqual({ '#k': { type: 'notFound' } });
	});
});
