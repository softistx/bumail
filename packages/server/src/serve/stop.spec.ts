import { describe, expect, test } from 'bun:test';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import type { OpenedStore } from '../store/open';
import { Spool } from './spool';
import { stopper } from './stop';

/** A stop of nothing but `storeCalls`, recording what happens in order. */
function running(storeCalls: Set<Promise<unknown>>, events: string[]) {
	return stopper({
		listeners: [],
		inflight: new Set(),
		storeCalls,
		opened: {
			close: async () => {
				events.push('store closed');
			},
		} as unknown as OpenedStore,
		directory: {
			close: () => events.push('directory closed'),
		} as unknown as Directory,
		spool: Spool.open(tempDir(), 1000),
		log: (line) => events.push(line),
		describe: String,
		drainMs: 0,
	});
}

describe('stopper', () => {
	test('waits for a store call under way before closing the store', async () => {
		const events: string[] = [];
		const calls = new Set<Promise<unknown>>();
		const call = Bun.sleep(150).then(() => events.push('call done'));
		calls.add(call);
		void call.then(() => calls.delete(call));
		await running(calls, events)();
		expect(events).toEqual([
			'call done',
			'store closed',
			'directory closed',
			'bumail: stopped',
		]);
	});

	test('force closes the store without waiting for it', async () => {
		const events: string[] = [];
		const calls = new Set<Promise<unknown>>([new Promise(() => {})]);
		await running(calls, events)({ force: true });
		expect(events).toEqual([
			'store closed',
			'directory closed',
			'bumail: stopped',
		]);
	});
});
