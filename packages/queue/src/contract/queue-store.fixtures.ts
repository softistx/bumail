import { describe } from 'bun:test';
import { describeClaims } from './fixtures/claims.fixtures';
import { describeConcurrency } from './fixtures/concurrency.fixtures';
import { describeItems } from './fixtures/items.fixtures';
import { describeOutcomes } from './fixtures/outcomes.fixtures';
import type { CreateStore, ShareStore } from './fixtures/setup.fixtures';

/**
 * The specs every `QueueStore` must pass. Each store's own spec calls this
 * with a factory, and with `share`, another handle on the same queue — a
 * second connection, as a second process opens — so the claim's atomicity
 * is checked across handles, not only within one.
 */
export function describeQueueStore(
	name: string,
	create: CreateStore,
	share: ShareStore = (store) => store,
): void {
	describe(`${name}: the QueueStore contract`, () => {
		const factories = { create, share };
		describeItems(factories);
		describeClaims(factories);
		describeOutcomes(factories);
		describeConcurrency(factories);
	});
}
