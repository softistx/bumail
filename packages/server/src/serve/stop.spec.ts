import { describe, expect, test } from 'bun:test';
import type { Queue, QueueStore } from '@bumail/queue';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import type { OpenedStore } from '../store/open';
import { Spool } from './spool';
import { stopper } from './stop';

/** A stop of nothing but `storeCalls` and a queue, recording what happens in order. */
function running(
	storeCalls: Set<Promise<unknown>>,
	events: string[],
	queueStop: () => Promise<void> = async () => {
		events.push('queue stopped');
	},
) {
	return stopper({
		listeners: [],
		inflight: new Set(),
		storeCalls,
		queue: { stop: queueStop } as unknown as Queue,
		queueStore: {
			store: {} as QueueStore,
			close: async () => {
				events.push('queue closed');
			},
		},
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
			'queue stopped',
			'call done',
			'queue closed',
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
			'queue stopped',
			'queue closed',
			'store closed',
			'directory closed',
			'bumail: stopped',
		]);
	});
});

describe('stopper: the queue', () => {
	test('waits for the queue to give its items back before closing its store', async () => {
		const events: string[] = [];
		await running(new Set(), events, async () => {
			await Bun.sleep(150);
			events.push('queue stopped');
		})();
		expect(events).toEqual([
			'queue stopped',
			'queue closed',
			'store closed',
			'directory closed',
			'bumail: stopped',
		]);
	});

	test('force leaves a queue delivery under way to its lease, and closes', async () => {
		const events: string[] = [];
		await running(
			new Set(),
			events,
			() => new Promise(() => {}),
		)({
			force: true,
		});
		expect(events).toEqual([
			'bumail: queue deliveries still under way are left to their leases',
			'queue closed',
			'store closed',
			'directory closed',
			'bumail: stopped',
		]);
	});
});
