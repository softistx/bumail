import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { createQueue, type Queue, type QueueLimits } from '@bumail/queue';
import { MemoryQueueStore } from '@bumail/queue/memory';
import type { SmtpServer } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { Spool } from './spool';
import { createSubmission } from './submission';
import { letter, session, submit } from './submission.fixtures';

let server: SmtpServer | undefined;
let directory: Directory | undefined;

afterEach(() => {
	server?.stop(true);
	directory?.close();
	server = undefined;
	directory = undefined;
});

/** A real queue on a memory store, never started: what it holds stays there to be read. */
function memoryQueue(limits: QueueLimits = {}): {
	queue: Queue;
	queueStore: MemoryQueueStore;
} {
	const queueStore = new MemoryQueueStore();
	const queue = createQueue({
		store: queueStore,
		hostname: 'mail.example.com',
		resolver: fixtureResolver({}),
		limits,
	});
	return { queue, queueStore };
}

async function start(
	queue: Queue,
	store = new MemoryMailStore(),
): Promise<{ port: number; lines: string[] }> {
	directory = await seededDirectory();
	const lines: string[] = [];
	server = createSubmission(
		{
			hostname: 'mail.example.com',
			directory,
			store,
			submission: {
				maxMessageSize: 1 << 20,
				maxRecipients: 10,
				maxConnections: 10,
				maxConnectionsPerClient: 10,
				handshakeTimeout: 10,
			},
			postmaster: undefined,
			tls: await selfSigned(['localhost']),
			spool: Spool.open(tempDir(), 1 << 24),
			queue,
			sign: async (_, message) => {
				await message.cancel();
				return undefined;
			},
			log: (line) => lines.push(line),
			onDelivered: () => {},
			track: (work) => work,
			describe: (error) =>
				error instanceof Error ? error.message : String(error),
		},
		'submissions',
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, lines };
}

/** Alice sends one message to `to`; the reply to it. */
async function sent(port: number, to: readonly string[]): Promise<string> {
	const client = await session(port, true, 'alice@example.com');
	const { last } = await submit(
		client,
		'alice@example.com',
		to,
		letter('alice@example.com', to[0] ?? '', 'handed on'),
	);
	client.end();
	return last;
}

describe('submission: handing on', () => {
	test('a store that fails queues nothing: the client sends it again, and it leaves once', async () => {
		const store = new MemoryMailStore();
		store.addMessage = () => Promise.reject(new Error('the store is down'));
		const { queue, queueStore } = memoryQueue();
		const { port } = await start(queue, store);
		const last = await sent(port, [
			'carol@elsewhere.example',
			'bob@example.com',
		]);
		expect(last).toMatch(/^4\d\d /);
		expect(await queueStore.count()).toBe(0);
	});

	test('local recipients first, then the queue for the others', async () => {
		const { queue, queueStore } = memoryQueue();
		const { port, lines } = await start(queue);
		const last = await sent(port, [
			'carol@elsewhere.example',
			'bob@example.com',
		]);
		expect(last).toStartWith('250 ');
		const [item] = await queueStore.list();
		expect(item?.recipients.map((r) => r.address)).toEqual([
			'carol@elsewhere.example',
		]);
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^submissions: \S+ from alice@example\.com <alice@example\.com> delivered to bob@example\.com; queued as \S+ for carol@elsewhere\.example \(unsigned\)$/,
			),
		);
	});

	test.each([
		[
			'full',
			{ maxItems: 1 },
			['carol@elsewhere.example'],
			'452 4.3.1 The queue is full, try again later',
		],
		[
			'too big',
			{ maxMessageSize: 100 },
			['carol@elsewhere.example'],
			'552 5.3.4 Message too big for the queue',
		],
		[
			'past its recipients',
			{ maxRecipients: 1 },
			['carol@elsewhere.example', 'dave@elsewhere.example'],
			'452 4.5.3 Too many recipients',
		],
	] as const)(
		'a queue %s answers its own reply',
		async (_, limits, to, answer) => {
			const { queue, queueStore } = memoryQueue(limits);
			// A full queue: one item already in it, its one place taken.
			const before = 'maxItems' in limits ? 1 : 0;
			if (before === 1) {
				await queue.enqueue(
					new TextEncoder().encode('Subject: x\r\n\r\nx\r\n'),
					{ from: 'bob@example.com', to: ['erin@elsewhere.example'] },
				);
			}
			const { port, lines } = await start(queue);
			expect(await sent(port, to)).toStartWith(answer);
			expect(await queueStore.count()).toBe(before);
			expect(lines.some((l) => l.includes(' not queued: '))).toBe(true);
		},
	);
});
